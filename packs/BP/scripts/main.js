import { world, system, ItemStack, EquipmentSlot } from "@minecraft/server";

// ===== 設定 =====
const LOCO_ID = "senro:steam_locomotive";
const ITEM_ID = "senro:steam_locomotive";
const FUEL_ITEMS = { "minecraft:coal": 3600, "minecraft:charcoal": 3600 }; // 1個 = 3600tick (3分)
const MAX_FUEL = 32000;
const MAX_SPEED = 0.6; // ブロック/tick。通常トロッコ(0.4)の1.5倍
const ACCEL = 0.05; // 1tickあたりの加速
const DIMENSIONS = ["overworld", "nether", "the_end"];

const P_FUEL = "senro:fuel";
const P_DX = "senro:dir_x";
const P_DZ = "senro:dir_z";

// ===== 燃料補給: 石炭/木炭を持って汽車を右クリック(タップ) =====
world.beforeEvents.playerInteractWithEntity.subscribe((ev) => {
  const { player, target, itemStack } = ev;
  if (target.typeId !== LOCO_ID) return;
  if (!itemStack || !(itemStack.typeId in FUEL_ITEMS)) return; // 燃料以外なら普通に乗る
  ev.cancel = true;
  const amount = FUEL_ITEMS[itemStack.typeId];
  system.run(() => addFuel(player, target, amount));
});

function addFuel(player, loco, amount) {
  if (!loco.isValid || !player.isValid) return;
  const fuel = loco.getDynamicProperty(P_FUEL) ?? 0;
  if (fuel + amount > MAX_FUEL) {
    player.onScreenDisplay.setActionBar("燃料が満タンです");
    return;
  }
  loco.setDynamicProperty(P_FUEL, fuel + amount);

  // 止まっているときは「プレイヤーから見て奥」に向かって走り出す
  const vel = loco.getVelocity();
  if (Math.hypot(vel.x, vel.z) < 0.02) {
    let dx = loco.location.x - player.location.x;
    let dz = loco.location.z - player.location.z;
    let len = Math.hypot(dx, dz);
    if (len < 0.01) {
      const v = player.getViewDirection();
      dx = v.x;
      dz = v.z;
      len = Math.hypot(dx, dz) || 1;
    }
    loco.setDynamicProperty(P_DX, dx / len);
    loco.setDynamicProperty(P_DZ, dz / len);
  }

  if (String(player.getGameMode()).toLowerCase() !== "creative") {
    const eq = player.getComponent("minecraft:equippable");
    const held = eq?.getEquipment(EquipmentSlot.Mainhand);
    if (held) {
      if (held.amount > 1) {
        held.amount -= 1;
        eq.setEquipment(EquipmentSlot.Mainhand, held);
      } else {
        eq.setEquipment(EquipmentSlot.Mainhand, undefined);
      }
    }
  }

  try {
    loco.dimension.playSound("fire.ignite", loco.location);
  } catch {}
  const secs = Math.floor((fuel + amount) / 20);
  player.onScreenDisplay.setActionBar(`燃料: 残り${Math.floor(secs / 60)}分${secs % 60}秒`);
}

// ===== 毎tick: 燃料がある汽車を前に押す =====
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
  const fuel = loco.getDynamicProperty(P_FUEL) ?? 0;
  if (fuel <= 0) return;
  loco.setDynamicProperty(P_FUEL, fuel - 1);

  const vel = loco.getVelocity();
  const speed = Math.hypot(vel.x, vel.z);
  let dx, dz;
  if (speed > 0.02) {
    // 走っている向き(カーブで向きが変わるので毎tick更新)
    dx = vel.x / speed;
    dz = vel.z / speed;
    loco.setDynamicProperty(P_DX, dx);
    loco.setDynamicProperty(P_DZ, dz);
  } else {
    dx = loco.getDynamicProperty(P_DX) ?? 0;
    dz = loco.getDynamicProperty(P_DZ) ?? 0;
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
        x: l.x + dx * 0.4,
        y: l.y + 1.35,
        z: l.z + dz * 0.4,
      });
    } catch {}
  }
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
