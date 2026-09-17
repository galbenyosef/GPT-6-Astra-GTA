import { angleDelta, clamp } from './collision';
import { addShot, clearShot, damagePlayer, traceBullet } from './combat';
import type { GameState, Point3, PoliceHelicopter, World } from './types';

const TAU = Math.PI * 2;
const GUN_OFFSET_Y = -1.1;
const GUN_OFFSET_Z = 1.7;
const BARREL_LENGTH = 1.4;

/** Shared turret transform keeps the visible barrel and hitscan in agreement. */
export function helicopterGunPose(helicopter: PoliceHelicopter, target: Point3) {
  const base: Point3 = { x: helicopter.x + Math.sin(helicopter.yaw) * GUN_OFFSET_Z,
    y: helicopter.y + GUN_OFFSET_Y, z: helicopter.z + Math.cos(helicopter.yaw) * GUN_OFFSET_Z };
  const dx = target.x - base.x, dy = target.y - base.y, dz = target.z - base.z;
  const yaw = Math.atan2(dx, dz);
  const pitch = Math.atan2(-dy, Math.hypot(dx, dz));
  const direction = { x: Math.sin(yaw) * Math.cos(pitch), y: -Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
  return { base, yaw: angleDelta(helicopter.yaw, yaw), pitch, direction,
    muzzle: { x: base.x + direction.x * BARREL_LENGTH, y: base.y + direction.y * BARREL_LENGTH, z: base.z + direction.z * BARREL_LENGTH } };
}

export function helicopterTarget(state: GameState): Point3 {
  return { x: state.player.x, y: state.player.vehicleId ? 1.5 : 1.3, z: state.player.z };
}

/** Air support follows across the entire city; scenery still blocks observation and fire. */
export function updatePoliceHelicopter(world: World, state: GameState, dt: number): boolean {
  if (state.police.wanted < 5 || state.combat.dead) { state.police.helicopter = null; return false; }
  if (!Number.isFinite(dt) || dt <= 0) return state.police.helicopter?.visible ?? false;
  // Aircraft can use the water around the island. Clamping to the pedestrian
  // boundary collapsed the following offset at corners and left it overhead.
  const extent = world.size / 2 + 120;
  const target = helicopterTarget(state);
  // Including the highest roof also protects the rotor/skids when crossing a block.
  const altitude = Math.max(34, ...world.buildings.map(building => building.height + 8), ...world.obstacles.map(solid => solid.height + 8));
  let helicopter = state.police.helicopter;
  if (!helicopter) {
    const side = target.x > 0 ? -1 : 1;
    helicopter = state.police.helicopter = {
      x: clamp(target.x + side * 108, -extent, extent), z: clamp(target.z - 76, -extent, extent), y: altitude,
      yaw: Math.atan2(-side * 108, 76), rotor: 0, fireCooldown: 3.8, burst: 0,
      spawnedAt: state.time, lastFireAt: -10, visible: false,
    };
  }
  const car = state.vehicles.find(vehicle => vehicle.id === state.player.vehicleId);
  const heading = car?.yaw ?? state.player.yaw;
  const lead = car ? Math.min(18, Math.abs(car.speed) * .55) : 0;
  const side = 26 + Math.sin((state.time - helicopter.spawnedAt) * .28) * 2;
  const ahead = 82 + lead;
  const offsetX = Math.sin(heading) * ahead + Math.cos(heading) * side;
  const offsetZ = Math.cos(heading) * ahead - Math.sin(heading) * side;
  const followingAngle = Math.atan2(offsetX, offsetZ);
  const currentAngle = Math.atan2(helicopter.x - target.x, helicopter.z - target.z);
  // Follow an arc when the player turns or reverses direction, instead of
  // cutting straight across the player to reach the other side of the orbit.
  const approachAngle = currentAngle + clamp(angleDelta(currentAngle, followingAngle), -.4, .4);
  const radius = Math.hypot(offsetX, offsetZ);
  const desiredX = clamp(target.x + Math.sin(approachAngle) * radius, -extent, extent);
  const desiredZ = clamp(target.z + Math.cos(approachAngle) * radius, -extent, extent);
  const dx = desiredX - helicopter.x, dz = desiredZ - helicopter.z;
  const distance = Math.hypot(dx, dz);
  const stride = Math.min(distance, Math.max(5, Math.min(42, distance * 2.2)) * dt);
  if (distance > 1e-7) { helicopter.x += dx / distance * stride; helicopter.z += dz / distance * stride; }
  helicopter.y += clamp(altitude + Math.sin(state.time * .7) * .6 - helicopter.y, -3 * dt, 3 * dt);
  helicopter.yaw = (helicopter.yaw + angleDelta(helicopter.yaw, Math.atan2(target.x - helicopter.x, target.z - helicopter.z)) * Math.min(1, dt * 3)) % TAU;
  helicopter.rotor = (helicopter.rotor + dt * 37) % TAU;
  helicopter.fireCooldown = Math.max(0, helicopter.fireCooldown - dt);
  const gun = helicopterGunPose(helicopter, target);
  const range = Math.hypot(target.x - gun.muzzle.x, target.y - gun.muzzle.y, target.z - gun.muzzle.z);
  const ignoreVehicle = state.player.vehicleId ?? undefined;
  helicopter.visible = range <= 155 && clearShot(world, state, gun.base, target, ignoreVehicle);
  if (state.player.vehicleId) {
    // Vehicle occupants are tracked, never attacked by air support. Cancel a
    // partly fired burst and give the player time to react after getting out.
    helicopter.burst = 0;
    helicopter.fireCooldown = Math.max(helicopter.fireCooldown, 1.2);
    helicopter.lastFireAt = -10;
    return helicopter.visible;
  }
  if (!helicopter.visible || range > 92 || helicopter.fireCooldown > 0) return helicopter.visible;

  // Three-round bursts with a recovery pause leave room to react and seek cover.
  // The first round is aimed; two suppression rounds pass either side of the target.
  const spread = helicopter.burst === 0 ? 0 : helicopter.burst === 1 ? 1.25 : -1.25;
  const yaw = Math.atan2(target.x - gun.muzzle.x, target.z - gun.muzzle.z);
  const aimed = { x: target.x + Math.cos(yaw) * spread, y: target.y, z: target.z - Math.sin(yaw) * spread };
  const hit = traceBullet(world, state, gun.muzzle, {
    x: aimed.x - gun.muzzle.x, y: aimed.y - gun.muzzle.y, z: aimed.z - gun.muzzle.z,
  }, 110, { includePlayer: true, ignoreVehicleId: ignoreVehicle });
  if (hit.kind === 'player') damagePlayer(state, 7);
  addShot(state, 'police', 'rifle', gun.muzzle, hit.point, hit.kind === 'player', 'police-helicopter');
  helicopter.lastFireAt = state.time;
  helicopter.burst = (helicopter.burst + 1) % 3;
  helicopter.fireCooldown = helicopter.burst ? .16 : 1.8;
  return helicopter.visible;
}
