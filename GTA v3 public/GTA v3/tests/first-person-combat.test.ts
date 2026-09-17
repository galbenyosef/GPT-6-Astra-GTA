import assert from 'node:assert/strict';
import test from 'node:test';
import { Simulation } from '../src/game/simulation';
import { updateCombat } from '../src/game/combat';
import { NO_INPUT, type AimRay, type Point3, type WeaponId } from '../src/game/types';

function fixture(z = 8) {
  const simulation = new Simulation(), { world, state } = simulation;
  const person = state.pedestrians[0];
  Object.assign(person, { id: 'target', x: 0, z, health: 100, state: 'waiting' });
  state.pedestrians = [person]; state.officers = []; state.vehicles = [];
  world.buildings = []; world.obstacles = [];
  Object.assign(state.player, { x: 0, z: 0, yaw: 0 });
  state.time = 1;
  const shoot = (ray: AimRay, weapon: WeaponId = 'pistol') => {
    updateCombat(world, state, 1 / 60, { ...NO_INPUT, viewYaw: 0, weapon, fire: true, aimRay: ray }, () => {});
    return state.combat.shots.at(-1)!;
  };
  return { world, state, person, shoot };
}

function eyeRay(target: Point3, muzzle = { x: -.24, y: 1.94, z: .95 }): AimRay {
  const origin = { x: 0, y: 2.23, z: 0 };
  const direction = { x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z };
  return { origin, direction, muzzle, perspective: 'first' };
}

test('first-person pistol and rifle converge from the held muzzle to the crosshair target', () => {
  for (const weapon of ['pistol', 'rifle'] as const) {
    const s = fixture();
    const ray = eyeRay({ x: 0, y: 1.5, z: 8 });
    const shot = s.shoot(ray, weapon);
    assert.equal(shot.hit, true);
    assert.equal(s.person.health, weapon === 'pistol' ? 60 : 75);
    assert.deepEqual(shot.from, ray.muzzle);
    // The hit is on the same eye ray, including its downward elevation.
    const eye = ray.origin, dir = ray.direction, t = (shot.to.z - eye.z) / dir.z;
    assert.ok(Math.abs(shot.to.x - (eye.x + dir.x * t)) < .001);
    assert.ok(Math.abs(shot.to.y - (eye.y + dir.y * t)) < .001);
  }
});

test('a first-person target closer than the barrel is still hit and cannot be shot through', () => {
  const s = fixture(.65);
  const shot = s.shoot(eyeRay({ x: 0, y: 1.6, z: .65 }));
  assert.equal(shot.hit, true);
  assert.equal(s.person.health, 60);
  assert.deepEqual(shot.from, { x: 0, y: 2.23, z: 0 });
  assert.ok(shot.to.z < .65);
});

test('first-person fire stops at close cover even when the visual muzzle is beyond it', () => {
  for (const z of [.35, .85, 2]) {
    const s = fixture();
    s.world.buildings.push({ id: 'wall', kind: 'building', x: 0, z, width: 5, depth: .1, height: 4, yaw: 0, style: 0, color: '#cccccc' });
    const shot = s.shoot(eyeRay({ x: 0, y: 1.5, z: 8 }));
    assert.equal(shot.hit, false);
    assert.equal(s.person.health, 100);
    assert.ok(shot.to.z <= z, 'the trace must end on the near surface');
    assert.ok(shot.from.z < z, 'the bullet must not spawn behind cover');
  }
});

test('off-center barrel cover blocks firing even when the crosshair has a clear view', () => {
  const s = fixture();
  s.world.obstacles.push({ id: 'barrel-cover', kind: 'barrier', x: -.16, z: .6, width: .12, depth: .12, height: 3, yaw: 0, color: '#cccccc' });
  const shot = s.shoot(eyeRay({ x: 0, y: 1.5, z: 8 }));
  assert.equal(shot.hit, false);
  assert.equal(s.person.health, 100);
  assert.ok(shot.to.z < .7);
});

test('first-person vertical aiming follows eye direction above and below the old shoulder limits', () => {
  for (const pitch of [-1.35, 1.35]) {
    const s = fixture();
    s.state.pedestrians = [];
    const ray: AimRay = { origin: { x: 0, y: 2.23, z: 0 }, direction: { x: 0, y: -Math.sin(pitch), z: Math.cos(pitch) }, perspective: 'first' };
    const shot = s.shoot(ray);
    const vector = { x: shot.to.x - shot.from.x, y: shot.to.y - shot.from.y, z: shot.to.z - shot.from.z };
    const length = Math.hypot(vector.x, vector.y, vector.z);
    assert.ok(Math.abs(vector.y / length - ray.direction.y) < 1e-8);
    assert.ok(Math.abs(vector.z / length - ray.direction.z) < 1e-8);
  }
});

test('invalid first-person muzzle data cannot teleport a shot past the player or cover', () => {
  for (const muzzle of [{ x: 0, y: 2, z: 40 }, { x: NaN, y: 2, z: 1 }, { x: 0, y: 2, z: -1 }]) {
    const s = fixture();
    const ray = eyeRay({ x: 0, y: 1.5, z: 8 }, muzzle);
    const shot = s.shoot(ray);
    assert.deepEqual(shot.from, ray.origin);
    assert.equal(shot.hit, true);
  }
});

test('first-person view does not enable attacks while driving, reloading or dead', () => {
  for (const mode of ['driving', 'reloading', 'dead'] as const) {
    const s = fixture();
    s.state.combat.weapon = 'pistol';
    if (mode === 'driving') s.state.player.vehicleId = 'occupied-car';
    if (mode === 'reloading') s.state.combat.reload = { weapon: 'pistol', remaining: .8, duration: 1.35 };
    if (mode === 'dead') s.state.combat.dead = true;
    s.shoot(eyeRay({ x: 0, y: 1.5, z: 8 }));
    assert.equal(s.person.health, 100);
    assert.equal(s.state.combat.ammo.pistol.magazine, 12);
    assert.equal(s.state.combat.shots.length, 0);
  }
});
