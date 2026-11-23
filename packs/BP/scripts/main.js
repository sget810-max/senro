import { world, system, ItemStack } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

// ===== 設定 =====
const LOCO_ID = "senro:steam_locomotive";
const ITEM_ID = "senro:steam_locomotive";
const THROTTLE_ID = "senro:throttle";
const FUEL_ITEMS = { "minecraft:coal": 3600, "minecraft:charcoal": 3600 }; // 1個 = 3600tick (3分)
const MAX_SPEED = 0.6; // ブロック/tick。通常トロッコ(0.4)の1.5倍
const ACCEL = 0.05; // 1tickあたりの加速
const BRAKE = 0.04; // 1tickあたりの減速
const DIMENSIONS = ["overworld", "nether", "the_end"];
// 汽車の見た目の向きがずれる場合の補正角度 (前後逆なら 180、横向きなら 90)
const YAW_OFFSET = 0;

const P_BURN = "senro:burn"; // 今燃えている石炭の残りtick
const P_RUN = "senro:running"; // 発車中かどうか
const P_BRAKE = "senro:braking"; // 停車ボタンで止まろうとしている途中か
const P_DX = "senro:dir_x";
const P_DZ = "senro:dir_z";

// ===== 燃料(汽車のインベントリ内の石炭) =====
function getContainer(loco) {
  return loco.getComponent("minecraft:inventory")?.container;
}

function countFuel(loco) {
  const c = getContainer(loco);
  if (!c) return 0;
  let n = 0;
  for (let i = 0; i < c.size; i++) {
    const it = c.getItem(i);
    if (it && it.typeId in FUEL_ITEMS) n += it.amount;
  }
  return n;
}

// 石炭を1個燃やす。燃やせたら true
function burnOne(loco) {
  const c = getContainer(loco);
  if (!c) return false;
  for (let i = 0; i < c.size; i++) {
    const it = c.getItem(i);
    if (!it || !(it.typeId in FUEL_ITEMS)) continue;
    const ticks = FUEL_ITEMS[it.typeId];
    if (it.amount > 1) {
      it.amount -= 1;
      c.setItem(i, it);
    } else {
      c.setItem(i, undefined);
    }
    loco.setDynamicProperty(P_BURN, (loco.getDynamicProperty(P_BURN) ?? 0) + ticks);
    return true;
  }
  return false;
}

function hasFuel(loco) {
  return (loco.getDynamicProperty(P_BURN) ?? 0) > 0 || countFuel(loco) > 0;
}

function riderPlayers(loco) {
  const r = loco.getComponent("minecraft:rideable");
  return (r?.getRiders() ?? []).filter((e) => e.typeId === "minecraft:player");
}

function tell(loco, msg) {
  for (const p of riderPlayers(loco)) p.onScreenDisplay.setActionBar(msg);
}

// ===== 運転メニュー =====
const lastMenu = new Map();

function openMenu(player, loco) {
  const now = system.currentTick;
  if (now - (lastMenu.get(player.id) ?? -100) < 10) return; // 二重に開かない
  lastMenu.set(player.id, now);

  const running = loco.getDynamicProperty(P_RUN) === true;
  const coal = countFuel(loco);
  const burnSec = Math.floor((loco.getDynamicProperty(P_BURN) ?? 0) / 20);
  const form = new ActionFormData()
    .title("汽車")
    .body(
      `状態: ${running ? "走行中" : "停車中"}\n` +
        `燃料: 石炭 ${coal} 個 + 燃焼中 残り${burnSec}秒\n\n` +
        "石炭は、汽車に乗ってインベントリを開くと入れられます。"
    )
    .button("発車（向いている方向へ）")
    .button("停車")
    .button("閉じる");

  form.show(player).then((res) => {
    if (res.canceled || !loco.isValid || !player.isValid) return;
    if (res.selection === 0) start(player, loco);
    else if (res.selection === 1) stop(player, loco);
  });
}

function start(player, loco) {
  if (!hasFuel(loco)) {
    player.onScreenDisplay.setActionBar("燃料(石炭)がありません");
    return;
  }
  const vel = loco.getVelocity();
  if (Math.hypot(vel.x, vel.z) < 0.05) {
    // 止まっているときはプレイヤーの向いている方向へ
    const v = player.getViewDirection();
    const len = Math.hypot(v.x, v.z) || 1;
    loco.setDynamicProperty(P_DX, v.x / len);
    loco.setDynamicProperty(P_DZ, v.z / len);
  }
  loco.setDynamicProperty(P_RUN, true);
  loco.setDynamicProperty(P_BRAKE, false);
  try {
    loco.dimension.playSound("fire.ignite", loco.location);
  } catch {}
  player.onScreenDisplay.setActionBar("発車！");
}

function stop(player, loco) {
  loco.setDynamicProperty(P_RUN, false);
  loco.setDynamicProperty(P_BRAKE, true);
  player.onScreenDisplay.setActionBar("停車します");
}

// 運転レバーを使う → 乗っている汽車のメニュー
world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== THROTTLE_ID) return;
  const loco = ev.source.getComponent("minecraft:riding")?.entityRidingOn;
  if (!loco || loco.typeId !== LOCO_ID) {
    ev.source.onScreenDisplay.setActionBar("汽車に乗って使うか、レバーで汽車をタップしてください");
    return;
  }
  openMenu(ev.source, loco);
});

// 運転レバーで汽車をタップ → メニュー / 石炭で汽車をタップ → 汽車のインベントリへ入れる
world.beforeEvents.playerInteractWithEntity.subscribe((ev) => {
  const { player, target, itemStack } = ev;
  if (target.typeId !== LOCO_ID || !itemStack) return;
  if (itemStack.typeId === THROTTLE_ID) {
    ev.cancel = true;
    system.run(() => openMenu(player, target));
  } else if (itemStack.typeId in FUEL_ITEMS) {
    ev.cancel = true;
    system.run(() => putFuelFromHand(player, target));
  }
});

function putFuelFromHand(player, loco) {
  if (!loco.isValid || !player.isValid) return;
  const c = getContainer(loco);
  const inv = player.getComponent("minecraft:inventory")?.container;
  if (!c || !inv) return;
  const slot = player.selectedSlotIndex;
  const held = inv.getItem(slot);
  if (!held || !(held.typeId in FUEL_ITEMS)) return;
  const left = c.addItem(held); // 全部入れる。入りきらない分は手元に残る
  inv.setItem(slot, left);
  player.onScreenDisplay.setActionBar(`汽車の燃料: 石炭 ${countFuel(loco)} 個`);
}

// ===== 毎tick: 汽車を動かす =====
system.runInterval(() => {
  const tick = system.currentTick;
  for (const dimId of DIMENSIONS) {
    let locos;
    try {
      locos = world.getDimension(dimId).getEntities({ type: LOCO_ID });
    } catch {
      continue;
    }
    for (const loco of locos) {
      try {
        driveLoco(loco, tick);
      } catch {}
    }
  }
}, 1);

function driveLoco(loco, tick) {
  const vel = loco.getVelocity();
  const speed = Math.hypot(vel.x, vel.z);

  updateFacing(loco, vel, speed);

  let dx, dz;
  if (speed > 0.02) {
    dx = vel.x / speed;
    dz = vel.z / speed;
  } else {
    dx = loco.getDynamicProperty(P_DX) ?? 0;
    dz = loco.getDynamicProperty(P_DZ) ?? 0;
  }

  const running = loco.getDynamicProperty(P_RUN) === true;
  if (!running) {
    // 「停車」を押したときだけ、止まるまでブレーキをかける。
    // それ以外(手で押す・坂を下るなど)は普通のトロッコと同じに動く
    if (loco.getDynamicProperty(P_BRAKE) === true) {
      if (speed > 0.03) {
        const b = Math.min(BRAKE, speed * 0.5); // 行き過ぎて逆走しないよう控えめに
        loco.applyImpulse({ x: -dx * b, y: 0, z: -dz * b });
      } else {
        loco.setDynamicProperty(P_BRAKE, false);
      }
    }
    return;
  }

  // 燃料
  let burn = loco.getDynamicProperty(P_BURN) ?? 0;
  if (burn <= 0) {
    if (!burnOne(loco)) {
      loco.setDynamicProperty(P_RUN, false);
      tell(loco, "燃料切れ！停車します");
      return;
    }
    burn = loco.getDynamicProperty(P_BURN);
  }
  loco.setDynamicProperty(P_BURN, burn - 1);

  if (speed > 0.02) {
    loco.setDynamicProperty(P_DX, dx);
    loco.setDynamicProperty(P_DZ, dz);
  }
  if (speed < MAX_SPEED && (dx !== 0 || dz !== 0)) {
    const push = Math.min(ACCEL, MAX_SPEED - speed + 0.01);
    loco.applyImpulse({ x: dx * push, y: 0, z: dz * push });
  }

  // 煙突の煙
  if (tick % 3 === 0) {
    const l = loco.location;
    try {
      loco.dimension.spawnParticle("minecraft:basic_smoke_particle", {
        x: l.x + dx * 0.3,
        y: l.y + 1.35,
        z: l.z + dz * 0.3,
      });
    } catch {}
  }
}

// ===== 汽車の向き (トロッコと同じようにレールに沿って回る) =====
function wrapDeg(a) {
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return a;
}

// a と a+180 のうち、今の向き cur に近い方
function nearerAxis(cur, a) {
  const b = wrapDeg(a + 180);
  return Math.abs(wrapDeg(a - cur)) <= Math.abs(wrapDeg(b - cur)) ? a : b;
}

// 足元のレールの向き (直線レールのみ)。南北 = 0、東西 = 90、それ以外 undefined
function railAxis(loco) {
  const l = loco.location;
  for (const dy of [0, -1]) {
    let block;
    try {
      block = loco.dimension.getBlock({ x: Math.floor(l.x), y: Math.floor(l.y) + dy, z: Math.floor(l.z) });
    } catch {
      return undefined;
    }
    if (!block || !block.typeId.includes("rail")) continue;
    const dir = block.permutation.getState("rail_direction");
    if (dir === 0 || dir === 4 || dir === 5) return 0;
    if (dir === 1 || dir === 2 || dir === 3) return 90;
    return undefined;
  }
  return undefined;
}

function updateFacing(loco, vel, speed) {
  const cur = loco.getProperty("senro:yaw") ?? 0;
  let target;
  if (speed > 0.02) {
    // 進行方向 (マイクラの向き: 南=0, 西=90, 北=180, 東=-90)
    const moveYaw = wrapDeg((Math.atan2(-vel.x, vel.z) * 180) / Math.PI + YAW_OFFSET);
    // 発車中は煙突を進行方向へ。押されて動いているだけなら前後はそのまま
    target = loco.getDynamicProperty(P_RUN) === true ? moveYaw : nearerAxis(cur, moveYaw);
  } else {
    const axis = railAxis(loco);
    if (axis === undefined) return;
    target = nearerAxis(cur, wrapDeg(axis + YAW_OFFSET));
  }
  const diff = wrapDeg(target - cur);
  if (Math.abs(diff) < 0.5) return;
  // なめらかに回す
  const next = Math.abs(diff) < 3 ? target : cur + diff * 0.5;
  loco.setProperty("senro:yaw", wrapDeg(next));
}

// ===== 壊したときのドロップを「汽車」アイテムにする =====
// 中身はバニラのトロッコ扱いなので、普通のトロッコを落とす。それを汽車に差し替える。
const pendingDrops = [];

world.beforeEvents.entityRemove.subscribe((ev) => {
  const e = ev.removedEntity;
  if (e.typeId !== LOCO_ID) return;
  pendingDrops.push({
    dim: e.dimension.id,
    x: e.location.x,
    y: e.location.y,
    z: e.location.z,
    tick: system.currentTick,
  });
});

world.afterEvents.entitySpawn.subscribe((ev) => {
  const ent = ev.entity;
  if (!ent.isValid || ent.typeId !== "minecraft:item") return;
  const stack = ent.getComponent("minecraft:item")?.itemStack;
  if (!stack || stack.typeId !== "minecraft:minecart") return;

  const now = system.currentTick;
  const l = ent.location;
  const idx = pendingDrops.findIndex(
    (p) =>
      now - p.tick <= 5 &&
      p.dim === ent.dimension.id &&
      Math.abs(p.x - l.x) < 2 &&
      Math.abs(p.y - l.y) < 2 &&
      Math.abs(p.z - l.z) < 2
  );
  if (idx < 0) return;
  pendingDrops.splice(idx, 1);
  const dim = ent.dimension;
  ent.remove();
  dim.spawnItem(new ItemStack(ITEM_ID, 1), l);
});

system.runInterval(() => {
  const now = system.currentTick;
  for (let i = pendingDrops.length - 1; i >= 0; i--) {
    if (now - pendingDrops[i].tick > 5) pendingDrops.splice(i, 1);
  }
}, 20);
