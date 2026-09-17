import test from 'node:test';
import assert from 'node:assert/strict';
import { boxIntersects, circleIntersectsBox, dist } from '../src/game/collision';
import { damagePlayer } from '../src/game/combat';
import { policeCanSee, policeLimit } from '../src/game/policePursuit';
import { Simulation } from '../src/game/simulation';
import { NO_INPUT, type InputFrame, type PoliceOfficer } from '../src/game/types';
import { VEHICLE_SPECS } from '../src/game/vehicles';

function scene() {
  const sim = new Simulation();
  const pedestrian = structuredClone(sim.state.pedestrians[0]);
  sim.world.buildings = []; sim.world.obstacles = [];
  sim.state.pedestrians = [];
  for (const car of sim.state.vehicles) car.active = false;
  Object.assign(sim.state.player, { x: 0, z: 0, yaw: 0, vehicleId: null });
  sim.state.police.reinforcementTimer = 1000;
  return { sim, pedestrian };
}

function advance(sim: Simulation, seconds: number, input: Partial<InputFrame> = {}) {
  for (let frame = 0; frame < Math.round(seconds * 90); frame++) sim.step(1 / 90, { ...NO_INPUT, ...input });
}

function officerAt(x: number, z: number, vehicleId = 'police-0'): PoliceOfficer {
  return { id: `officer-${vehicleId}`, vehicleId, x, z, yaw: 0, health: 100,
    state: 'engaging', fireCooldown: 100, phase: 0, deadAt: null, weapon: 'pistol' };
}

function drivingScene(speed: number) {
  const fixture = scene();
  const car = fixture.sim.state.vehicles.find(vehicle => vehicle.id === 'courier-01')!;
  Object.assign(car, { active: true, x: 0, z: 0, yaw: 0, speed, steer: 0 });
  fixture.sim.state.player.vehicleId = car.id;
  return { ...fixture, car };
}

function armoredScene() {
  const fixture = scene();
  const car = fixture.sim.state.vehicles.find(vehicle => vehicle.id === 'police-0')!;
  Object.assign(car, { active: true, model: 'armored', x: 0, z: -24, yaw: 0, speed: 0,
    width: VEHICLE_SPECS.armored.width, depth: VEHICLE_SPECS.armored.depth });
  fixture.sim.state.police.wanted = 5;
  return { ...fixture, car };
}

test('real driving impacts report one star, while a gentle touch or near miss adds no heat', () => {
  for (const kind of ['wall', 'vehicle'] as const) for (const speed of [1.2, 4]) {
    const { sim, car } = drivingScene(speed);
    const front = car.depth / 2 + .52;
    if (kind === 'wall') sim.world.obstacles = [{ id: 'wall', kind: 'barrier', x: 0, z: front,
      width: 8, depth: 1, height: 3, yaw: 0, color: '#777' }];
    else {
      const other = sim.state.vehicles.find(vehicle => vehicle.id === 'parked-east')!;
      Object.assign(other, { active: true, x: 0, z: car.depth / 2 + other.depth / 2 + .02, yaw: 0, speed: 0 });
    }
    sim.state.police.cooldown = 10;
    advance(sim, .1);
    assert.equal(sim.state.police.wanted, speed > 1.5 ? 1 : 0, `${kind} at ${speed} m/s`);
    assert.equal(sim.state.collisions, speed > 1.5 ? 1 : 0);
  }
  const { sim, car, pedestrian } = drivingScene(14);
  const person = { ...pedestrian, x: car.width / 2 + .66, z: 3, speed: 0, state: 'waiting' as const, timer: 10 };
  sim.state.pedestrians = [person];
  advance(sim, .4);
  assert.equal(person.health, 100);
  assert.equal(sim.state.police.wanted, 0, 'passing close without touching is not a collision');
});

test('high-speed pedestrian and officer impacts are lethal and escalate to three or five stars', () => {
  for (const kind of ['pedestrian', 'officer'] as const) {
    const { sim, car, pedestrian } = drivingScene(12);
    const z = car.depth / 2 + .5;
    const victim = kind === 'officer' ? officerAt(0, z) : { ...pedestrian, x: 0, z, speed: 0, state: 'waiting' as const, timer: 10 };
    if (kind === 'officer') sim.state.officers = [victim as PoliceOfficer];
    else sim.state.pedestrians = [victim as typeof pedestrian];
    sim.step(1 / 90, NO_INPUT);
    assert.equal(victim.state, 'dead');
    assert.equal(victim.health, 0);
    assert.equal(sim.state.police.wanted, kind === 'officer' ? 5 : 3);
    const body = { x: victim.x, z: victim.z, phase: victim.phase, deadAt: victim.deadAt };
    const collisions = sim.state.collisions;
    // Drive through the same body again without making a second victim/report.
    Object.assign(car, { x: 0, z: 0, speed: 12 });
    sim.step(1 / 90, NO_INPUT);
    assert.deepEqual({ x: victim.x, z: victim.z, phase: victim.phase, deadAt: victim.deadAt }, body);
    assert.equal(sim.state.collisions, collisions);
    assert.ok(car.speed > 10, 'a fallen body no longer blocks or slows the car');
  }
});

test('gentle actor contact blocks without killing and scenery shields an actor behind it', () => {
  for (const speed of [1.2, 4]) {
    const { sim, car, pedestrian } = drivingScene(speed);
    const victim = { ...pedestrian, x: 0, z: car.depth / 2 + .56, speed: 0, state: 'waiting' as const, timer: 10 };
    sim.state.pedestrians = [victim];
    advance(sim, .1);
    assert.equal(victim.health, 100);
    assert.equal(sim.state.police.wanted, speed > 1.5 ? 1 : 0);
    assert.ok(!circleIntersectsBox(victim.x, victim.z, .5, car));
  }
  const { sim, car, pedestrian } = drivingScene(20);
  const victim = { ...pedestrian, x: 0, z: car.depth / 2 + .56, speed: 0, state: 'waiting' as const, timer: 10 };
  sim.state.pedestrians = [victim];
  sim.world.obstacles = [{ id: 'shield', kind: 'barrier', x: 0, z: car.depth / 2 + .15,
    width: 8, depth: .2, height: 2, yaw: 0, color: '#777' }];
  sim.step(1 / 90, NO_INPUT);
  assert.equal(victim.health, 100);
  assert.equal(sim.state.police.wanted, 1);
});

test('an officer killing dispatches six sedans and two armored crews from hidden clear positions', () => {
  const { sim } = scene();
  const victim = officerAt(0, 1.6);
  sim.state.officers = [victim];
  sim.step(1 / 90, { ...NO_INPUT, weapon: 'knife', fire: true, viewYaw: 0 });
  assert.equal(victim.state, 'dead');
  assert.equal(sim.state.police.wanted, 5);
  const cars = sim.state.vehicles.filter(car => car.kind === 'police' && car.active);
  assert.equal(cars.length, policeLimit(5));
  assert.equal(cars.filter(car => car.model === 'sedan').length, 6);
  assert.equal(cars.filter(car => car.model === 'armored').length, 2);
  for (const car of cars) {
    assert.ok(dist(car, sim.state.player) >= 124 || !policeCanSee(sim.world, sim.state, car, car.id, Infinity));
    assert.ok(cars.every(other => other === car || !boxIntersects(car, other)));
    const crew = sim.state.officers.filter(officer => officer.vehicleId === car.id);
    assert.equal(crew.length, car.model === 'armored' ? 2 : 1);
    assert.ok(crew.every(officer => officer.state === 'riding' && officer.weapon === (car.model === 'armored' ? 'rifle' : 'pistol')));
  }
  assert.ok(sim.state.police.helicopter);
  advance(sim, .6);
  sim.step(1 / 90, { ...NO_INPUT, weapon: 'pistol', fire: true, viewYaw: Math.PI / 2 });
  assert.equal(sim.state.police.wanted, 5, 'a minor report cannot downgrade the five-star response');
  const positions = cars.map(car => ({ x: car.x, z: car.z }));
  sim.state.police.reinforcementTimer = 0;
  sim.step(1 / 90, NO_INPUT);
  assert.equal(sim.state.vehicles.filter(car => car.kind === 'police' && car.active).length, 8);
  assert.ok(cars.every((car, index) => dist(car, positions[index]) < .5), 'active responders are not teleported by dispatch');
});

test('armored officers dismount separately into clear space and both fire rifle bursts', () => {
  const { sim, car } = armoredScene();
  sim.step(1 / 90, NO_INPUT);
  const crew = sim.state.officers.filter(officer => officer.vehicleId === car.id);
  assert.equal(crew.length, 2);
  assert.equal(crew.filter(officer => officer.state === 'engaging').length, 1);
  assert.equal(crew.filter(officer => officer.state === 'riding').length, 1);
  advance(sim, .25);
  assert.equal(crew.filter(officer => officer.state === 'riding').length, 1);
  advance(sim, .25);
  assert.ok(crew.every(officer => officer.state === 'engaging'));
  assert.ok(dist(crew[0], crew[1]) > .78);
  assert.ok(crew.every(officer => !circleIntersectsBox(officer.x, officer.z, .38, car)));
  assert.equal(car.speed, 0);
  assert.equal(sim.state.combat.health, 100, 'both officers give an initial reaction delay');
  for (const officer of crew) officer.fireCooldown = 0;
  sim.state.police.helicopter!.fireCooldown = 100;
  const observed = new Map<number, (typeof sim.state.combat.shots)[number]>();
  for (let frame = 0; frame < 45; frame++) {
    sim.step(1 / 90, NO_INPUT);
    for (const shot of sim.state.combat.shots) if (shot.owner === 'police') observed.set(shot.id, shot);
  }
  const shots = [...observed.values()];
  assert.equal(shots.length, 6);
  assert.ok(shots.every(shot => shot.weapon === 'rifle'));
  assert.ok(crew.every(officer => shots.some(shot => dist(shot.from, officer) < 2)));
  assert.ok(sim.state.combat.health < 100);
});

test('an armored crew waits at blocked doors and keeps exits separated when only one side is clear', () => {
  const { sim, car } = armoredScene();
  sim.world.obstacles = [-1, 1].map(side => ({ id: `door-wall-${side}`, kind: 'barrier' as const,
    x: side * 2.3, z: car.z + .5, width: 1, depth: 8, height: 3, yaw: 0, color: '#777' }));
  advance(sim, .7);
  const crew = sim.state.officers.filter(officer => officer.vehicleId === car.id);
  assert.ok(crew.every(officer => officer.state === 'riding'));
  assert.equal(car.speed, 0);
  sim.world.obstacles = sim.world.obstacles.filter(solid => solid.x > 0);
  for (let frame = 0; frame < 90; frame++) {
    sim.step(1 / 90, NO_INPUT);
    const foot = crew.filter(officer => officer.state !== 'riding');
    for (const officer of foot) {
      assert.ok(!circleIntersectsBox(officer.x, officer.z, .38, car));
      assert.ok(sim.world.obstacles.every(solid => !circleIntersectsBox(officer.x, officer.z, .38, solid)));
    }
    if (foot.length === 2) assert.ok(dist(foot[0], foot[1]) >= .76);
  }
  assert.ok(crew.every(officer => officer.state === 'engaging' && officer.x < 0));
});

test('a surviving armored officer returns and drives without reviving or retiring their fallen partner', () => {
  const { sim, car } = armoredScene();
  advance(sim, .6);
  const [fallen, survivor] = sim.state.officers.filter(officer => officer.vehicleId === car.id);
  Object.assign(fallen, { state: 'dead', health: 0, deadAt: sim.state.time });
  const body = { x: fallen.x, z: fallen.z, phase: fallen.phase };
  sim.state.police.wanted = 0;
  Object.assign(sim.state.player, { x: 180, z: 180 });
  let boarded = false;
  for (let frame = 0; frame < 15 * 90; frame++) {
    const before = { x: survivor.x, z: survivor.z, state: survivor.state };
    sim.step(1 / 90, NO_INPUT);
    if (survivor.state !== 'riding') {
      assert.equal(car.speed, 0);
      assert.ok(dist(survivor, before) <= 4.4 / 90 + .001);
    } else boarded = true;
  }
  assert.ok(boarded);
  assert.equal(survivor.state, 'riding');
  assert.ok(car.active && car.speed > 0);
  assert.deepEqual({ x: fallen.x, z: fallen.z, phase: fallen.phase }, body);
  assert.ok(sim.state.officers.includes(fallen));
  assert.equal(sim.state.officers.filter(officer => officer.vehicleId === car.id).length, 2);
  assert.equal(sim.state.police.helicopter, null);
  Object.assign(survivor, { state: 'dead', health: 0, deadAt: sim.state.time - 9 });
  sim.step(1 / 90, NO_INPUT);
  assert.equal(car.active, false);
  assert.equal(sim.state.officers.filter(officer => officer.vehicleId === car.id).length, 0);
});

test('both armored officers walk back before their vehicle resumes a moving pursuit', () => {
  const { sim, car } = armoredScene();
  advance(sim, .6);
  const crew = sim.state.officers.filter(officer => officer.vehicleId === car.id);
  const playerCar = sim.state.vehicles.find(vehicle => vehicle.id === 'courier-01')!;
  Object.assign(playerCar, { active: true, x: 0, z: 0, yaw: 0, speed: 12 });
  sim.state.player.vehicleId = playerCar.id;
  sim.state.police.helicopter!.fireCooldown = 100;
  let returning = false;
  let resumed = false;
  for (let frame = 0; frame < 5 * 90; frame++) {
    sim.step(1 / 90, { ...NO_INPUT, forward: 1 });
    returning ||= crew.some(officer => officer.state === 'returning');
    if (crew.some(officer => officer.state !== 'riding')) assert.equal(car.speed, 0);
    else resumed ||= car.speed > 2;
  }
  assert.ok(returning && resumed);
  assert.ok(crew.every(officer => officer.state === 'riding'));
  assert.ok(crew.every(officer => dist(officer, car) < .001));
});

test('five-star death and mission reset clear air support and all squad ownership', () => {
  const { sim } = armoredScene();
  advance(sim, .6);
  assert.ok(sim.state.police.helicopter && sim.state.officers.length === 2);
  damagePlayer(sim.state, 100);
  sim.step(1 / 90, NO_INPUT);
  assert.equal(sim.state.police.helicopter, null);
  assert.ok(sim.state.vehicles.filter(car => car.kind === 'police').every(car => car.speed === 0));
  advance(sim, 4.1);
  assert.equal(sim.state.combat.health, 100);
  assert.equal(sim.state.police.wanted, 0);
  assert.equal(sim.state.police.helicopter, null);
  assert.deepEqual(sim.state.officers, []);
});
