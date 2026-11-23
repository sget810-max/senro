import { world, system, ItemStack } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { getTrain, getLinks, CART_TYPES, BOOSTER_ID } from "./coupling.js";

// ===== 設定 =====
const LOCO_ID = "senro:steam_locomotive";
const ITEM_ID = "senro:steam_locomotive";
const THROTTLE_ID = "senro:throttle";
const FUEL_ITEMS = { "minecraft:coal": 3600, "minecraft:charcoal": 3600 }; // 1個 = 3600tick (3分)
const MAX_SPEED = 0.6; // ブロック/tick。通常トロッコ(0.4)の1.5倍
const BOOSTED_MAX_SPEED = 0.8; // 補助機関車が編成にいるとき。通常トロッコの2倍
const ACCEL = 0.05; // 1tickあたりの加速
const BRAKE = 0.04; // 1tickあたりの減速
const DIMENSIONS = ["overworld", "nether", "the_end"];
// 汽車の見た目の向きがずれる場合の補正角度 (前後逆なら 180、横向きなら 90)
const YAW_OFFSET = 0;

const P_BURN = "senro:burn"; // 今燃えている石炭の残りtick
const P_RUN = "senro:running"; // 発車中かどうか
const P_BRAKE = "senro:braking"; // 停車ボタンで止まろうとしている途中か
// スティック入力が使えない版のときだけ使う、発車の向き
const P_SENSE = "senro:sense"; // 前進中 1 / 後退中 -1
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

// 編成のどの車両に乗っている人にも知らせる
const lastTell = new Map(); // playerId -> tick (スピードメーターで上書きしないため)
function tell(loco, msg) {
  for (const car of getTrain(loco).cars)
    for (const p of riderPlayers(car)) {
      p.onScreenDisplay.setActionBar(msg);
      lastTell.set(p.id, system.currentTick);
    }
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
      `状態: ${running ? "火が入っている (運転できます)" : "火が消えている"}\n` +
        `燃料: 石炭 ${coal} 個 + 燃焼中 残り${burnSec}秒\n\n` +
        "運転: 乗ってスティックを前に倒すと煙突の方へ、後ろに倒すと逆へ走り出します。\n" +
        "走り出したら、石炭がある限り全速で走り続けます。走っている向きと逆に倒すとブレーキ。\n\n" +
        "石炭は、汽車に乗ってインベントリを開くと入れられます。"
    )
    .button(running ? "火を消して停車" : "火を入れる")
    .button("閉じる");

  form.show(player).then((res) => {
    if (res.canceled || !loco.isValid || !player.isValid) return;
    if (res.selection === 0) (running ? stop : start)(player, loco);
  });
}

function start(player, loco) {
  if (!hasFuel(loco)) {
    player.onScreenDisplay.setActionBar("燃料(石炭)がありません");
    return;
  }
  loco.setDynamicProperty(P_RUN, true);
  loco.setDynamicProperty(P_BRAKE, false);
  try {
    loco.dimension.playSound("fire.ignite", loco.location);
  } catch {}
  if (typeof player.inputInfo?.getMovementVector === "function") {
    loco.setDynamicProperty(P_DX, undefined);
    loco.setDynamicProperty(P_DZ, undefined);
    player.onScreenDisplay.setActionBar("火が入りました。スティックを前後に倒すと走ります");
  } else {
    // この版ではスティック入力が読めないので、向いている方向へ発車する
    const v = player.getViewDirection();
    const len = Math.hypot(v.x, v.z) || 1;
    loco.setDynamicProperty(P_DX, v.x / len);
    loco.setDynamicProperty(P_DZ, v.z / len);
    player.onScreenDisplay.setActionBar("発車！ (この版ではスティック操作が使えないため、向いている方向へ)");
  }
}

function stop(player, loco) {
  loco.setDynamicProperty(P_RUN, false);
  loco.setDynamicProperty(P_DX, undefined);
  loco.setDynamicProperty(P_DZ, undefined);
  loco.setDynamicProperty(P_BRAKE, true);
  player.onScreenDisplay.setActionBar("火を消して停車します");
}

// 運転レバーを使う → 乗っている車両の編成の汽車のメニュー
world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== THROTTLE_ID) return;
  const ride = ev.source.getComponent("minecraft:riding")?.entityRidingOn;
  const loco = ride && CART_TYPES.has(ride.typeId) ? findLoco(ride) : undefined;
  if (!loco) {
    ev.source.onScreenDisplay.setActionBar(
      ride ? "この編成には汽車がありません" : "汽車の編成に乗って使うか、レバーで車両をタップしてください"
    );
    return;
  }
  openMenu(ev.source, loco);
});

// 運転レバーで車両をタップ → 編成の汽車のメニュー / 石炭で汽車をタップ → 汽車のインベントリへ入れる
world.beforeEvents.playerInteractWithEntity.subscribe((ev) => {
  const { player, target, itemStack } = ev;
  if (!itemStack || !CART_TYPES.has(target.typeId)) return;
  if (itemStack.typeId === THROTTLE_ID) {
    // 同じ編成の車両ならどれをタップしても汽車のメニュー
    ev.cancel = true;
    system.run(() => {
      if (!target.isValid) return;
      const loco = findLoco(target);
      if (loco) openMenu(player, loco);
      else player.onScreenDisplay.setActionBar("この編成には汽車がありません");
    });
  } else if (target.typeId === LOCO_ID && itemStack.typeId in FUEL_ITEMS) {
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
    // 補助機関車は自分では走らないが、向きはレールに合わせる
    let boosters = [];
    try {
      boosters = world.getDimension(dimId).getEntities({ type: BOOSTER_ID });
    } catch {}
    for (const b of boosters) {
      try {
        const v = b.getVelocity();
        updateFacing(b, v, Math.hypot(v.x, v.z));
      } catch {}
    }
  }
}, 1);

// ===== スピードメーター: 汽車の編成に乗っている人に今の速さを表示 =====
const SPEED_LABEL = {
  "senro:speed_normal": "1倍",
  "senro:speed_15": "1.5倍",
  "senro:speed_20": "2倍 (補助機関車)",
};
system.runInterval(() => {
  const now = system.currentTick;
  for (const dimId of DIMENSIONS) {
    let locos;
    try {
      locos = world.getDimension(dimId).getEntities({ type: LOCO_ID });
    } catch {
      continue;
    }
    for (const loco of locos) {
      try {
        const cars = getTrain(loco).cars;
        const riders = cars.flatMap((c) => riderPlayers(c));
        if (!riders.length) continue;
        const v = loco.getVelocity();
        const bps = Math.hypot(v.x, v.z) * 20;
        const level = loco.getDynamicProperty(P_SPEED);
        const cap = cars.some((c) => c.typeId === BOOSTER_ID) ? BOOSTED_MAX_SPEED : MAX_SPEED;
        const fire = loco.getDynamicProperty(P_RUN) === true ? "火あり" : "火なし";
        const msg = `速度 ${bps.toFixed(1)} ブロック/秒 ｜ 設定 ${SPEED_LABEL[level] ?? "未設定"} (上限 ${cap * 20}) ｜ ${fire}`;
        for (const p of riders) {
          if (now - (lastTell.get(p.id) ?? -100) < 40) continue;
          p.onScreenDisplay.setActionBar(msg);
        }
      } catch {}
    }
  }
}, 5);

// ===== 車両の最高速度を切り替える =====
// レールでの最高速度はエンティティ定義のコンポーネントグループで決まるので、
// 編成に合わせてイベントで切り替える (バニラのトロッコも上書き定義に同じイベントがある)
//   汽車のいない車両: 通常 / 汽車の編成: 1.5倍 / 補助機関車も入った編成: 2倍
const P_SPEED = "senro:speed";

function setSpeed(cart, level) {
  if (cart.getDynamicProperty(P_SPEED) === level) return;
  try {
    cart.triggerEvent(level);
    cart.setDynamicProperty(P_SPEED, level);
  } catch {}
}

function speedLevelOf(cars) {
  if (!cars.some((c) => c.typeId === LOCO_ID)) return "senro:speed_normal";
  return cars.some((c) => c.typeId === BOOSTER_ID) ? "senro:speed_20" : "senro:speed_15";
}

function syncSpeed(cart) {
  if (!cart.isValid || !CART_TYPES.has(cart.typeId)) return;
  const cars = getTrain(cart).cars;
  const level = speedLevelOf(cars);
  for (const c of cars) {
    setSpeed(c, level);
    syncCoupled(c);
  }
}

// 連結している車両どうしは押し合わず、乗り上げもしないようにする
// (タグ senro_coupled はエンティティ定義の押し合いの条件で使う)
const P_COUPLED = "senro:coupled_state";
function syncCoupled(cart) {
  const coupled = getLinks(cart).length > 0;
  const state = coupled ? "on" : "off";
  if (cart.getDynamicProperty(P_COUPLED) === state) return;
  try {
    if (coupled) cart.addTag("senro_coupled");
    else cart.removeTag("senro_coupled");
    cart.setDynamicProperty(P_COUPLED, state);
    cart.triggerEvent(coupled ? "senro:unstack" : "senro:stack");
  } catch {}
}

// 新しく出てきた・読み込まれた車両はすぐ設定する (設定前はレールの上を走れないため)
world.afterEvents.entitySpawn.subscribe((ev) => system.run(() => syncSpeed(ev.entity)));
world.afterEvents.entityLoad.subscribe((ev) => system.run(() => syncSpeed(ev.entity)));

system.runInterval(() => {
  const done = new Set();
  for (const dimId of DIMENSIONS) {
    let carts;
    try {
      carts = world.getDimension(dimId).getEntities({ families: ["minecart"] });
    } catch {
      continue;
    }
    for (const cart of carts) {
      if (done.has(cart.id) || !CART_TYPES.has(cart.typeId)) continue;
      const cars = getTrain(cart).cars;
      const level = speedLevelOf(cars);
      for (const c of cars) {
        done.add(c.id);
        setSpeed(c, level);
        syncCoupled(c);
      }
    }
  }
}, 5);

// 車両の編成にいる汽車 (なければ undefined)
function findLoco(cart) {
  if (cart.typeId === LOCO_ID) return cart;
  return getTrain(cart).cars.find((c) => c.typeId === LOCO_ID);
}

// 編成のどれかの車両に乗っている人のスティック入力: 前 = 1, 後ろ = -1, なし = 0
function riderInput(cars) {
  for (const p of cars.flatMap((c) => riderPlayers(c))) {
    let v;
    try {
      v = p.inputInfo?.getMovementVector?.();
    } catch {}
    if (!v) continue;
    if (v.y > 0.3) return 1;
    if (v.y < -0.3) return -1;
  }
  return 0;
}

// 汽車の前 (煙突の方) の向き
function frontDir(loco) {
  const yaw = (((loco.getProperty("senro:yaw") ?? 0) - YAW_OFFSET) * Math.PI) / 180;
  return { x: -Math.sin(yaw), z: Math.cos(yaw) };
}

function brakeTrain(cars, loco, locoVel) {
  for (const car of cars) {
    const v = car === loco ? locoVel : car.getVelocity();
    const s = Math.hypot(v.x, v.z);
    if (s < 0.01) continue;
    const b = Math.min(BRAKE, s * 0.5); // 行き過ぎて逆走しないよう控えめに
    car.applyImpulse({ x: (-v.x / s) * b, y: 0, z: (-v.z / s) * b });
  }
}

function driveLoco(loco, tick) {
  const vel = loco.getVelocity();
  const speed = Math.hypot(vel.x, vel.z);

  updateFacing(loco, vel, speed);

  const running = loco.getDynamicProperty(P_RUN) === true;
  if (!running) {
    // 「火を消して停車」のときだけ、止まるまでブレーキ。石炭切れのときは惰性で止まる
    if (loco.getDynamicProperty(P_BRAKE) === true) {
      if (speed > 0.03) brakeTrain(getTrain(loco).cars, loco, vel);
      else loco.setDynamicProperty(P_BRAKE, false);
    }
    return;
  }

  const train = getTrain(loco).cars;
  // 汽車が2両以上いる編成では、IDが一番小さい汽車の煙突の向きを「前」にそろえる
  const lead = train.filter((c) => c.typeId === LOCO_ID).sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? loco;
  const front = frontDir(lead);
  const input = riderInput(train);

  // 進む向き: 走っていればその向き、止まっていればスティックの向き
  let dx, dz;
  if (speed > 0.02) {
    dx = vel.x / speed;
    dz = vel.z / speed;
    // 前進中なら 1、後退中なら -1。カーブの途中では進む向きと煙突の向きが直角近くになり
    // 判定がぶれるので、はっきりしているときだけ更新して覚えておく
    const dot = dx * front.x + dz * front.z;
    let along = loco.getDynamicProperty(P_SENSE) ?? (dot >= 0 ? 1 : -1);
    if (Math.abs(dot) > 0.5) {
      along = dot > 0 ? 1 : -1;
      if (loco.getDynamicProperty(P_SENSE) !== along) loco.setDynamicProperty(P_SENSE, along);
    }
    if (input !== 0 && input !== along) {
      // 走っている向きと逆に倒した → ブレーキ (止まったら逆向きに走り出す)
      brakeTrain(train, loco, vel);
      return;
    }
  } else if (input !== 0) {
    dx = front.x * input;
    dz = front.z * input;
    loco.setDynamicProperty(P_SENSE, input);
  } else if (loco.getDynamicProperty(P_DX) !== undefined) {
    dx = loco.getDynamicProperty(P_DX); // スティック入力が使えない版の発車
    dz = loco.getDynamicProperty(P_DZ);
  } else {
    return; // 止まっていて入力なし: 待機 (燃料も減らない)
  }

  // 燃料 (力をかけている間だけ減る)
  let burn = loco.getDynamicProperty(P_BURN) ?? 0;
  if (burn <= 0) {
    if (!burnOne(loco)) {
      loco.setDynamicProperty(P_RUN, false);
      tell(loco, "石炭切れ！惰性で止まります");
      return;
    }
    burn = loco.getDynamicProperty(P_BURN);
  }
  loco.setDynamicProperty(P_BURN, burn - 1);

  // パワードレールと同じように、走っている向きへ全速まで押し続ける
  const maxSpeed = train.some((c) => c.typeId === BOOSTER_ID) ? BOOSTED_MAX_SPEED : MAX_SPEED;
  if (speed < maxSpeed) {
    const push = Math.min(ACCEL, maxSpeed - speed + 0.01);
    loco.applyImpulse({ x: dx * push, y: 0, z: dz * push });
  }
  // 編成の車両も、それぞれ自分の進む向きに押す (カーブでは車両ごとに向きが違うため)。
  // 止まっている車両は連結で引っぱられて動き出す
  for (const car of train) {
    if (car === loco) continue;
    const v = car.getVelocity();
    const s = Math.hypot(v.x, v.z);
    if (s < 0.02 || s >= maxSpeed) continue;
    const push = Math.min(ACCEL, maxSpeed - s + 0.01);
    car.applyImpulse({ x: (v.x / s) * push, y: 0, z: (v.z / s) * push });
  }

  // 煙突の煙
  if (tick % 3 === 0) {
    const l = loco.location;
    try {
      loco.dimension.spawnParticle("minecraft:basic_smoke_particle", {
        x: l.x + front.x * 0.3,
        y: l.y + 2.0,
        z: l.z + front.z * 0.3,
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
    // 前後は入れ替えない (後退しても煙突は前のまま)。レールの向きにだけ合わせる
    target = nearerAxis(cur, moveYaw);
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

// ===== 壊したときのドロップを「汽車」「補助機関車」アイテムにする =====
// 中身はバニラのトロッコ扱いなので、普通のトロッコを落とす。それを差し替える。
const DROP_ITEMS = { [LOCO_ID]: ITEM_ID, [BOOSTER_ID]: "senro:booster_locomotive" };
const pendingDrops = [];

world.beforeEvents.entityRemove.subscribe((ev) => {
  const e = ev.removedEntity;
  if (!(e.typeId in DROP_ITEMS)) return;
  pendingDrops.push({
    item: DROP_ITEMS[e.typeId],
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
  const item = pendingDrops[idx].item;
  pendingDrops.splice(idx, 1);
  const dim = ent.dimension;
  ent.remove();
  dim.spawnItem(new ItemStack(item, 1), l);
});

system.runInterval(() => {
  const now = system.currentTick;
  for (let i = pendingDrops.length - 1; i >= 0; i--) {
    if (now - pendingDrops[i].tick > 5) pendingDrops.splice(i, 1);
  }
}, 20);
