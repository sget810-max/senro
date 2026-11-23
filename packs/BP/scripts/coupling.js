// ===== 連結機能 =====
// 連結器を持ってトロッコを2台タップするとつながる。つながった車両どうしは
// トロッコと同じ銀色の棒 (senro:coupling_link) で結ばれて見える。
import { world, system } from "@minecraft/server";

export const LOCO_ID = "senro:steam_locomotive";
export const BOOSTER_ID = "senro:booster_locomotive";
const COUPLER_ID = "senro:coupler";
const ROD_ID = "senro:coupling_link";
export const CART_TYPES = new Set([
  LOCO_ID,
  BOOSTER_ID,
  "minecraft:minecart",
  "minecraft:chest_minecart",
  "minecraft:hopper_minecart",
  "minecraft:tnt_minecart",
  "minecraft:command_block_minecart",
]);

const MAX_CARS = 8; // 1編成の最大両数 (先頭の汽車を含む)
const COUPLE_RANGE = 4; // つなげる距離 (ブロック)
const GAP = 1.6; // 連結時の車両の中心どうしの間隔
const SLACK_PULL = 0.1; // これ以上離れたら引っぱる
const SLACK_PUSH = 0.2; // これ以上近づいたら押し返す (車体どうしがぶつからない程度)
const BREAK_DIST = 10; // これ以上離れたら切れる
const HALF_LEN = 0.625; // 車体の長さの半分
const LINK_HEIGHT = 0.3; // 紐の高さ
const P_LINKS = "senro:links"; // つながっている相手のIDを "," 区切りで保存 (最大2)
const P_ROD_KEY = "senro:rod_key";
const DIMENSIONS = ["overworld", "nether", "the_end"];

// ---------- 連結データ ----------
export function getLinks(cart) {
  const s = cart.getDynamicProperty(P_LINKS);
  return typeof s === "string" && s ? s.split(",") : [];
}

function setLinks(cart, ids) {
  cart.setDynamicProperty(P_LINKS, ids.length ? ids.join(",") : undefined);
}

function addLink(a, b) {
  setLinks(a, [...getLinks(a), b.id]);
  setLinks(b, [...getLinks(b), a.id]);
}

function removeLink(a, bId) {
  setLinks(a, getLinks(a).filter((id) => id !== bId));
}

function linkKey(idA, idB) {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

// 同じ編成の車両 (読み込まれているもの) と、編成全体の両数
export function getTrain(cart) {
  const seen = new Set([cart.id]);
  const loaded = [cart];
  const queue = [cart];
  while (queue.length) {
    const c = queue.shift();
    for (const id of getLinks(c)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = world.getEntity(id);
      if (e && e.isValid) {
        loaded.push(e);
        queue.push(e);
      }
    }
  }
  return { cars: loaded, count: seen.size };
}

// ---------- 連結器の操作 ----------
const pending = new Map(); // playerId -> { cartId, tick }

function say(player, msg) {
  player.onScreenDisplay.setActionBar(msg);
}

world.beforeEvents.playerInteractWithEntity.subscribe((ev) => {
  const { player, target, itemStack } = ev;
  if (itemStack?.typeId !== COUPLER_ID || !CART_TYPES.has(target.typeId)) return;
  ev.cancel = true; // 乗ったりチェストを開いたりしない
  const sneaking = player.isSneaking;
  system.run(() => {
    if (player.isValid && target.isValid) onCouplerTap(player, target, sneaking);
  });
});

// 何もない所で連結器を使う → 選ぶのをやめる
world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== COUPLER_ID) return;
  if (pending.delete(ev.source.id)) say(ev.source, "連結をやめました");
});

function onCouplerTap(player, cart, sneaking) {
  // スニークしながらタップ: その車両の連結を全部外す
  if (sneaking) {
    pending.delete(player.id);
    const ids = getLinks(cart);
    for (const id of ids) {
      const other = world.getEntity(id);
      if (other) removeLink(other, cart.id);
    }
    setLinks(cart, []);
    say(player, ids.length ? "この車両の連結を全部外しました" : "この車両はつながっていません");
    return;
  }

  const p = pending.get(player.id);
  const first = p ? world.getEntity(p.cartId) : undefined;

  if (!first || !first.isValid) {
    // 1台目
    if (getLinks(cart).length >= 2) {
      say(player, "この車両は前後ともつながっています");
      return;
    }
    if (getTrain(cart).count >= MAX_CARS) {
      say(player, `1編成は${MAX_CARS}両までです`);
      return;
    }
    pending.set(player.id, { cartId: cart.id, tick: system.currentTick });
    say(player, "つなぐ相手の車両をタップ (何もない所で使うとやめる)");
    return;
  }

  // 2台目
  pending.delete(player.id);
  if (first.id === cart.id) {
    say(player, "連結をやめました");
    return;
  }
  if (getLinks(first).includes(cart.id)) {
    removeLink(first, cart.id);
    removeLink(cart, first.id);
    say(player, "切り離しました");
    return;
  }
  if (first.dimension.id !== cart.dimension.id || dist(first.location, cart.location) > COUPLE_RANGE) {
    say(player, "遠すぎてつなげません");
    return;
  }
  if (getLinks(first).length >= 2 || getLinks(cart).length >= 2) {
    say(player, "つなげるのは前後1台ずつです");
    return;
  }
  const ta = getTrain(first);
  const tb = getTrain(cart);
  if (ta.cars.some((c) => c.id === cart.id)) {
    say(player, "同じ編成どうしは輪にできません");
    return;
  }
  if (ta.count + tb.count > MAX_CARS) {
    say(player, `1編成は${MAX_CARS}両までです`);
    return;
  }
  addLink(first, cart);
  try {
    cart.dimension.playSound("random.anvil_land", cart.location, { volume: 0.4, pitch: 1.6 });
  } catch {}
  say(player, `連結しました (${ta.count + tb.count}両編成)`);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ---------- 毎tick: 間隔を保つ / 紐を描く ----------
const lastPos = new Map(); // id -> { dim, x, y, z }  (壊れたかどうかの判定用)
const rods = new Map(); // key -> rod entity id

system.runInterval(() => {
  const carts = new Map();
  for (const dimId of DIMENSIONS) {
    let list;
    try {
      list = world.getDimension(dimId).getEntities({ families: ["minecart"] });
    } catch {
      continue;
    }
    for (const c of list) {
      if (CART_TYPES.has(c.typeId) && getLinks(c).length) carts.set(c.id, c);
    }
  }

  // つながりの一覧を作る (壊れた相手との連結は外す)
  const links = [];
  const seenKeys = new Set();
  for (const c of carts.values()) {
    lastPos.set(c.id, { dim: c.dimension.id, ...c.location });
    for (const id of getLinks(c)) {
      const other = carts.get(id) ?? world.getEntity(id);
      if (!other || !other.isValid) {
        if (partnerDestroyed(c, id)) removeLink(c, id);
        continue;
      }
      const key = linkKey(c.id, id);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (other.dimension.id !== c.dimension.id || dist(c.location, other.location) > BREAK_DIST) {
        removeLink(c, id);
        removeLink(other, c.id);
        continue;
      }
      links.push([c, other, key]);
    }
  }

  keepDistance(links);
  drawRods(links);
}, 1);

// 相手が見つからないとき: 最後にいた場所が読み込まれているなら、壊されたと判断
function partnerDestroyed(cart, id) {
  const lp = lastPos.get(id);
  if (!lp || lp.dim !== cart.dimension.id) return false;
  if (dist(lp, cart.location) > 16) return false;
  try {
    return cart.dimension.getBlock({ x: Math.floor(lp.x), y: Math.floor(lp.y), z: Math.floor(lp.z) }) !== undefined;
  } catch {
    return false;
  }
}

// 連結した車両の間隔を GAP に保つ (ばね＋ダンパーを速度で解く)
function keepDistance(links) {
  if (!links.length) return;
  const vel = new Map();
  const imp = new Map();
  const pos = new Map();
  for (const [a, b] of links) {
    for (const e of [a, b]) {
      if (!vel.has(e.id)) {
        const v = e.getVelocity();
        vel.set(e.id, { x: v.x, z: v.z });
        imp.set(e.id, { x: 0, z: 0 });
        pos.set(e.id, e.location);
      }
    }
  }
  for (let iter = 0; iter < 3; iter++) {
    for (const [a, b] of links) {
      const pa = pos.get(a.id), pb = pos.get(b.id);
      let nx = pb.x - pa.x, nz = pb.z - pa.z;
      const d = Math.hypot(nx, nz);
      if (d < 0.01) continue;
      nx /= d;
      nz /= d;
      const va = vel.get(a.id), vb = vel.get(b.id);
      // 本物の連結器のように「遊び」を持たせる。カーブでは車両の中心どうしの直線距離が
      // 線路に沿った距離より短くなるので、少し近づいたくらいでは押し返さない
      // (押し返すと、その力の一部が進む向きと逆に働いて減速してしまう)
      let e = d - GAP;
      if (e > SLACK_PULL) e -= SLACK_PULL;
      else if (e < -SLACK_PUSH) e += SLACK_PUSH;
      else e = 0;
      const vrel = (vb.x - va.x) * nx + (vb.z - va.z) * nz;
      if (e === 0) continue; // 遊びの中: 何もしない (それぞれ自由に走る)
      const desired = Math.max(-0.3, Math.min(0.3, -e * 0.25));
      const dv = (desired - vrel) * 0.4; // 両方に半分ずつ
      va.x -= nx * dv; va.z -= nz * dv;
      vb.x += nx * dv; vb.z += nz * dv;
      const ia = imp.get(a.id), ib = imp.get(b.id);
      ia.x -= nx * dv; ia.z -= nz * dv;
      ib.x += nx * dv; ib.z += nz * dv;
    }
  }
  for (const [a, b] of links) {
    for (const ent of [a, b]) {
      const i = imp.get(ent.id);
      if (!i || (Math.abs(i.x) < 1e-4 && Math.abs(i.z) < 1e-4)) continue;
      try {
        ent.applyImpulse({ x: i.x, y: 0, z: i.z });
      } catch {}
      i.x = 0;
      i.z = 0;
    }
  }
}

// 紐 (銀色の棒) を描く
function drawRods(links) {
  const want = new Map(); // key -> { dim, from, to, trimFrom, trimTo }
  for (const [a, b, key] of links) {
    want.set(key, { dim: a.dimension, from: a.location, to: b.location, trimFrom: HALF_LEN, trimTo: HALF_LEN, dy: LINK_HEIGHT });
  }
  // 連結器で1台目を選んでいる途中: 車両から手元まで
  const now = system.currentTick;
  for (const [pid, p] of pending) {
    const player = world.getEntity(pid);
    const cart = world.getEntity(p.cartId);
    if (!player || !cart || !player.isValid || !cart.isValid || now - p.tick > 1200 || !holdingCoupler(player) ||
        player.dimension.id !== cart.dimension.id || dist(player.location, cart.location) > 12) {
      pending.delete(pid);
      continue;
    }
    const hand = { x: player.location.x, y: player.location.y + 0.9, z: player.location.z };
    want.set(`p|${pid}`, { dim: cart.dimension, from: { x: cart.location.x, y: cart.location.y + LINK_HEIGHT, z: cart.location.z }, to: hand, trimFrom: HALF_LEN, trimTo: 0.2, dy: 0 });
  }

  // 要らなくなった棒を消す / 再読み込み後の棒を引き継ぐ
  for (const dimId of DIMENSIONS) {
    let list;
    try {
      list = world.getDimension(dimId).getEntities({ type: ROD_ID });
    } catch {
      continue;
    }
    for (const rod of list) {
      const key = rod.getDynamicProperty(P_ROD_KEY);
      if (typeof key !== "string" || !want.has(key)) {
        rod.remove();
        continue;
      }
      const known = rods.get(key);
      if (known === undefined || !world.getEntity(known)) rods.set(key, rod.id);
      else if (known !== rod.id) rod.remove();
    }
  }
  for (const key of [...rods.keys()]) if (!want.has(key)) rods.delete(key);

  for (const [key, w] of want) {
    let rod = rods.has(key) ? world.getEntity(rods.get(key)) : undefined;
    const geo = rodGeometry(w);
    if (!geo) continue;
    if (!rod || !rod.isValid) {
      try {
        rod = w.dim.spawnEntity(ROD_ID, geo.mid);
      } catch {
        continue;
      }
      rod.setDynamicProperty(P_ROD_KEY, key);
      rods.set(key, rod.id);
    }
    try {
      rod.teleport(geo.mid, { rotation: { x: 0, y: 0 } });
      rod.setProperty("senro:yaw", geo.yaw);
      rod.setProperty("senro:pitch", geo.pitch);
      rod.setProperty("senro:len", geo.len);
    } catch {}
  }
}

function rodGeometry(w) {
  const fx = w.from.x, fy = w.from.y + w.dy, fz = w.from.z;
  const tx = w.to.x, ty = w.to.y + w.dy, tz = w.to.z;
  let dx = tx - fx, dy = ty - fy, dz = tz - fz;
  const d = Math.hypot(dx, dy, dz);
  if (d < 0.01) return undefined;
  dx /= d;
  dy /= d;
  dz /= d;
  const len = Math.max(0.05, Math.min(8, d - w.trimFrom - w.trimTo));
  const startT = w.trimFrom + len / 2;
  const mid = { x: fx + dx * startT, y: fy + dy * startT, z: fz + dz * startT };
  const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
  const pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
  return { mid, yaw, pitch, len };
}

function holdingCoupler(player) {
  try {
    const inv = player.getComponent("minecraft:inventory")?.container;
    return inv?.getItem(player.selectedSlotIndex)?.typeId === COUPLER_ID;
  } catch {
    return false;
  }
}
