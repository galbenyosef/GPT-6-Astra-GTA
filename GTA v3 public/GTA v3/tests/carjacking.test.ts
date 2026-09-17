import assert from 'node:assert/strict';
import test from 'node:test';
import { CARJACKING_TIMING, carjackingReleaseTime, planCarjacking, sampleCarjacking } from '../src/game/carjacking';
import { circleIntersectsBox, dist } from '../src/game/collision';
import { damagePlayer, damageVictim } from '../src/game/combat';
import { Simulation } from '../src/game/simulation';
import { NO_INPUT, type CarjackingState, type InputFrame, type VehicleModel } from '../src/game/types';
import { getVehicleAccess } from '../src/game/vehicleAccess';

const MODELS = ['sedan', 'truck', 'pickup', 'hatchback', 'sport'] as const;

function scene(model: VehicleModel = 'sedan', yaw = 0, passengerSide = false) {
  const sim = new Simulation();
  sim.world.buildings = []; sim.world.obstacles = [];
  sim.state.pedestrians = [];
  for (const vehicle of sim.state.vehicles) vehicle.active = false;
  const car = sim.state.vehicles.find(vehicle => vehicle.kind === 'traffic' && vehicle.model === model)!;
  Object.assign(car, { active: true, x: 0, z: 0, yaw, speed: 6, steer: .2, route: [{ x: 0, z: 60 }], waypoint: 0 });
  const access = getVehicleAccess(model);
  const local = { x: access.approach.x * (passengerSide ? -1 : 1), z: access.approach.z };
  Object.assign(sim.state.player, { x: Math.cos(yaw) * local.x + Math.sin(yaw) * local.z,
    z: -Math.sin(yaw) * local.x + Math.cos(yaw) * local.z, yaw: yaw - Math.PI / 2, vehicleId: null });
  sim.state.police.reinforcementTimer = 1000;
  return { sim, car, access };
}

function advance(sim: Simulation, seconds: number, input: Partial<InputFrame> = {}) {
  for (let frame = 0; frame < Math.round(seconds * 90); frame++) sim.step(1 / 90, { ...NO_INPUT, ...input });
}

function finish(sim: Simulation, input: Partial<InputFrame> = {}) {
  for (let frame = 0; frame < 12 * 90 && sim.state.carjacking; frame++) sim.step(1 / 90, { ...NO_INPUT, ...input });
  assert.equal(sim.state.carjacking, null, 'the sequence must finish or cancel within its bounded approach and entry time');
}

function start(sim: Simulation): CarjackingState {
  sim.interact();
  const sequence = sim.state.carjacking;
  assert.ok(sequence, sim.state.message);
  return sequence;
}

test('traffic starts with deterministic occupants while mission and parked vehicles remain empty', () => {
  const first = new Simulation(), second = new Simulation();
  for (const car of first.state.vehicles) {
    if (car.kind === 'traffic') {
      assert.equal(car.driver?.id, `driver-${car.id}`);
      assert.ok(car.driver?.color);
      assert.deepEqual(car.driver, second.state.vehicles.find(vehicle => vehicle.id === car.id)?.driver);
    } else assert.equal(car.driver, null);
  }
});

for (const model of MODELS) test(`${model} takes its moving driver's car through every phase before transferring control`, () => {
  const { sim, car } = scene(model, Math.PI / 2);
  const original = { ...car.driver! };
  const parked = { x: car.x, z: car.z, yaw: car.yaw };
  const sequence = start(sim);
  assert.equal(car.speed, 0);
  assert.equal(car.kind, 'traffic');
  assert.equal(sim.state.player.vehicleId, null);
  assert.match(sim.getHint(), /Taking vehicle/);
  const phases = new Set<string>();
  let released = false;
  while (sim.state.carjacking) {
    phases.add(sim.state.carjacking.phase);
    sim.step(1 / 90, NO_INPUT);
    assert.deepEqual({ x: car.x, z: car.z, yaw: car.yaw }, parked, 'the driver cannot resume AI traffic motion during the sequence');
    if (sim.state.carjacking) assert.equal(sim.state.player.vehicleId, null, 'control only transfers after the door closes');
    if (sequence.driverReleased) {
      released = true;
      assert.equal(car.driver, null);
      assert.equal(car.kind, 'parked');
      assert.equal(sim.state.pedestrians.filter(person => person.id === original.id).length, 1);
    } else {
      assert.deepEqual(car.driver, original);
      assert.equal(sim.state.pedestrians.length, 0);
    }
  }
  assert.deepEqual(phases, new Set(['approach', 'open', 'pull', 'fall', 'enter', 'close']));
  assert.ok(released);
  assert.equal(sim.state.player.vehicleId, car.id);
  assert.deepEqual(car.route, []);
  assert.equal(sim.state.police.wanted, 0, 'the nonlethal removal does not invent a new wanted-level rule');
  const driver = sim.state.pedestrians.find(person => person.id === original.id)!;
  assert.equal(driver.color, original.color);
  assert.equal(driver.health, 100);
  assert.equal(driver.state, 'fleeing');
  assert.ok(driver.recoverUntil! > sim.state.time);
  const fallen = { x: driver.x, z: driver.z, phase: driver.phase };
  advance(sim, CARJACKING_TIMING.recover - .1);
  assert.deepEqual({ x: driver.x, z: driver.z, phase: driver.phase }, fallen, 'the driver gets up before locomotion resumes');
  advance(sim, 2);
  assert.ok(dist(driver, fallen) > 3, 'the living driver runs away after recovering');
  assert.ok(Number.isFinite(driver.timer));
  advance(sim, .8, { forward: 1 });
  assert.ok(car.speed > 5 && dist(car, parked) > 2);
});

test('a passenger-side approach walks around the rotated body instead of crossing through it', () => {
  for (const model of MODELS) {
    const { sim, car } = scene(model, -.7, true);
    const sequence = start(sim);
    assert.ok(sequence.approachPath.length >= 3);
    assert.ok(sequence.approachDuration > 1);
    let last = { x: sim.state.player.x, z: sim.state.player.z };
    while (sim.state.carjacking?.phase === 'approach') {
      sim.step(1 / 90, NO_INPUT);
      assert.ok(dist(sim.state.player, last) < .055, 'the approach uses ordinary walking distance per step');
      assert.ok(!circleIntersectsBox(sim.state.player.x, sim.state.player.z, .46, car));
      last = { x: sim.state.player.x, z: sim.state.player.z };
    }
    finish(sim);
    assert.equal(sim.state.player.vehicleId, car.id);
  }
});

test('movement, repeated interaction and weapons remain locked while police can still damage the player', () => {
  const { sim, car } = scene();
  sim.state.combat.weapon = 'pistol';
  sim.state.combat.ammo.pistol.magazine = 3;
  sim.state.combat.reload = { weapon: 'pistol', remaining: .1, duration: .1 };
  const patrol = sim.state.vehicles.find(vehicle => vehicle.id === 'police-0')!;
  Object.assign(patrol, { active: true, x: 10, z: -12, speed: 0 });
  sim.state.officers = [{ id: 'officer-police-0', vehicleId: patrol.id, x: 8, z: .5, yaw: -Math.PI / 2,
    health: 100, state: 'engaging', fireCooldown: 0, phase: 0, deadAt: null }];
  sim.state.police.wanted = 3;
  const sequence = start(sim);
  const ammunition = structuredClone(sim.state.combat.ammo);
  const id = sequence.driver.id;
  let policeShot = false;
  for (let frame = 0; frame < 60; frame++) {
    sim.interact();
    sim.step(1 / 90, { ...NO_INPUT, forward: 1, turn: 1, sprint: true, fire: true, weapon: 'rifle', reload: true, interact: true });
    assert.equal(sim.state.carjacking, sequence);
    const sample = sampleCarjacking(sequence);
    assert.ok(dist(sample.player, sim.state.player) < 1e-9);
    assert.equal(car.speed, 0);
    assert.ok(!sim.state.combat.shots.some(shot => shot.owner === 'player'));
    policeShot ||= sim.state.combat.shots.some(shot => shot.owner === 'police');
  }
  assert.equal(sim.state.combat.weapon, 'pistol');
  assert.deepEqual(sim.state.combat.ammo, ammunition);
  assert.equal(sim.state.combat.reload, null);
  assert.ok(policeShot && sim.state.combat.health < 100 && sim.state.combat.health > 0, 'the ordinary police update continues firing and applying damage');
  assert.equal(sim.state.carjacking, sequence);
  finish(sim, { interact: true, forward: 1 });
  assert.equal(sim.state.player.vehicleId, car.id);
  assert.equal(sim.state.pedestrians.filter(person => person.id === id).length, 1);
  assert.equal(sim.state.police.wanted, 3);
});

test('blocked door swing and landing corridors reject entry without stopping or removing the driver', () => {
  for (const obstruction of ['wall', 'vehicle'] as const) {
    const { sim, car } = scene();
    const driver = car.driver;
    const x = car.width / 2 + 1.3;
    if (obstruction === 'wall') sim.world.obstacles = [{ id: 'garage-wall', kind: 'barrier', x, z: 0,
      width: .5, depth: 8, height: 3, yaw: 0, color: '#777' }];
    else {
      const neighbor = sim.state.vehicles.find(vehicle => vehicle.id === 'police-0')!;
      Object.assign(neighbor, { active: true, x: x + .7, z: 0, yaw: 0, speed: 0 });
    }
    sim.interact();
    assert.equal(sim.state.carjacking, null);
    assert.equal(sim.state.player.vehicleId, null);
    assert.equal(car.driver, driver);
    assert.equal(car.kind, 'traffic');
    assert.equal(car.speed, 6);
    assert.equal(sim.state.pedestrians.length, 0);
    assert.match(sim.state.message, /blocked/i);
  }
});

test('a new obstruction on the approach cancels safely and leaves the original traffic driver in charge', () => {
  const { sim, car } = scene('truck', 0, true);
  const driver = car.driver;
  const sequence = start(sim);
  advance(sim, .15);
  const next = sampleCarjacking({ ...sequence, elapsed: sequence.elapsed + .1 }).player;
  sim.world.obstacles.push({ id: 'new-blocker', kind: 'barrier', x: next.x, z: next.z,
    width: .8, depth: .8, height: 3, yaw: 0, color: '#777' });
  const before = { x: sim.state.player.x, z: sim.state.player.z };
  sim.step(1 / 90, NO_INPUT);
  assert.equal(sim.state.carjacking, null);
  assert.equal(car.driver, driver);
  assert.equal(car.kind, 'traffic');
  assert.equal(sim.state.pedestrians.length, 0);
  assert.ok(!circleIntersectsBox(sim.state.player.x, sim.state.player.z, .46, car));
  assert.ok(sim.world.obstacles.every(solid => !circleIntersectsBox(sim.state.player.x, sim.state.player.z, .46, solid)));
  assert.ok(dist(sim.state.player, before) < 6, 'cancellation stays on a previously validated nearby approach');
});

test('reset before release restores traffic while reset after release preserves the empty car and living driver', () => {
  for (const afterRelease of [false, true]) {
    const { sim, car } = scene();
    const sequence = start(sim), driverId = sequence.driver.id;
    advance(sim, afterRelease ? carjackingReleaseTime(sequence) + .15 : .25);
    assert.equal(sequence.driverReleased, afterRelease);
    sim.restartMission();
    assert.equal(sim.state.carjacking, null);
    assert.equal(sim.state.player.vehicleId, null);
    assert.equal(car.kind, afterRelease ? 'parked' : 'traffic');
    assert.equal(car.driver?.id ?? null, afterRelease ? null : driverId);
    const driver = sim.state.pedestrians.find(person => person.id === driverId);
    assert.equal(!!driver, afterRelease);
    if (driver) {
      assert.equal(driver.health, 100);
      assert.ok(driver.recoverUntil! > sim.state.time);
    } else {
      advance(sim, 1);
      assert.ok(car.speed > 0 && Math.hypot(car.x, car.z) > 1, 'the original driver can resume traffic after cancellation');
    }
  }
});

test('death during entry cancels ownership but keeps the released driver and car through respawn', () => {
  const { sim, car } = scene();
  const sequence = start(sim);
  advance(sim, carjackingReleaseTime(sequence) + CARJACKING_TIMING.fall + .6);
  assert.equal(sequence.phase, 'enter');
  damagePlayer(sim.state, 100);
  sim.step(1 / 90, NO_INPUT);
  assert.equal(sim.state.carjacking, null);
  assert.equal(sim.state.player.vehicleId, null);
  assert.equal(car.kind, 'parked');
  assert.equal(car.driver, null);
  assert.ok(!circleIntersectsBox(sim.state.player.x, sim.state.player.z, .46, car));
  const driver = sim.state.pedestrians.find(person => person.id === sequence.driver.id)!;
  assert.equal(driver.health, 100);
  advance(sim, 4.1);
  assert.equal(sim.state.combat.health, 100);
  assert.equal(sim.state.carjacking, null);
  assert.equal(car.driver, null);
  assert.equal(sim.state.pedestrians.filter(person => person.id === driver.id).length, 1);
});

test('an emptied vehicle can be reentered repeatedly without ghost drivers or repeated ejection', () => {
  const { sim, car } = scene();
  const sequence = start(sim);
  finish(sim);
  const driver = sim.state.pedestrians.find(person => person.id === sequence.driver.id)!;
  advance(sim, 2.5);
  for (let index = 0; index < 4; index++) {
    sim.interact();
    assert.equal(sim.state.player.vehicleId, null);
    sim.interact();
    assert.equal(sim.state.player.vehicleId, car.id);
    assert.equal(sim.state.carjacking, null);
    assert.equal(sim.state.pedestrians.filter(person => person.id === driver.id).length, 1);
    assert.equal(car.driver, null);
  }
  const reports: number[] = [];
  damageVictim(sim.state, driver, 100, level => reports.push(level));
  assert.equal(driver.state, 'dead');
  assert.deepEqual(reports, [3], 'a later lethal attack still treats the ejected driver as a civilian');
});

test('a released driver killed during entry stays dead while the player finishes taking the empty vehicle', () => {
  const { sim, car } = scene();
  const sequence = start(sim);
  advance(sim, carjackingReleaseTime(sequence) + .15);
  const driver = sim.state.pedestrians.find(person => person.id === sequence.driver.id)!;
  assert.ok(driver);
  damageVictim(sim.state, driver, 100, () => {});
  const body = { x: driver.x, z: driver.z, phase: driver.phase, deadAt: driver.deadAt };
  finish(sim);
  assert.equal(sim.state.player.vehicleId, car.id);
  assert.equal(car.driver, null);
  assert.equal(driver.state, 'dead');
  assert.equal(driver.health, 0);
  assert.deepEqual({ x: driver.x, z: driver.z, phase: driver.phase, deadAt: driver.deadAt }, body);
  assert.equal(sim.state.pedestrians.filter(person => person.id === driver.id).length, 1);
});

test('the choreography is continuous, finite and preserves exact seat/door endpoints in every body model', () => {
  for (const model of MODELS) {
    const { sim, car } = scene(model, 1.3);
    const sequence = planCarjacking(sim.world, sim.state, car)!;
    assert.ok(sequence);
    const bounds = [sequence.approachDuration, sequence.approachDuration + CARJACKING_TIMING.open, carjackingReleaseTime(sequence),
      carjackingReleaseTime(sequence) + CARJACKING_TIMING.fall, sequence.duration - CARJACKING_TIMING.close];
    for (const elapsed of bounds) {
      const a = sampleCarjacking({ ...sequence, elapsed: elapsed - 1e-7 });
      const b = sampleCarjacking({ ...sequence, elapsed: elapsed + 1e-7 });
      for (const actor of ['player', 'driver'] as const) {
        assert.ok(dist(a[actor], b[actor]) < 1e-4);
        assert.ok(Math.abs(a[actor].y - b[actor].y) < 1e-4);
        assert.ok(Math.abs(a[actor].pitch - b[actor].pitch) < 1e-4);
      }
      assert.ok(Math.abs(a.doorOpen - b.doorOpen) < 1e-4);
    }
    for (let elapsed = 0; elapsed < sequence.duration; elapsed += 1 / 90) {
      const sample = sampleCarjacking({ ...sequence, elapsed });
      for (const actor of [sample.player, sample.driver]) assert.ok(Object.values(actor).every(Number.isFinite));
      assert.ok(sample.doorOpen >= 0 && sample.doorOpen <= 1);
      assert.ok(sample.playerSeated >= 0 && sample.playerSeated <= 1 && sample.driverSeated >= 0 && sample.driverSeated <= 1);
    }
    const last = sampleCarjacking({ ...sequence, elapsed: sequence.duration });
    assert.ok(dist(last.player, sequence.seat) < 1e-9);
    assert.equal(last.player.y, sequence.seat.y);
    assert.equal(last.playerSeated, 1);
    assert.equal(last.doorOpen, 0);
    assert.equal(last.driverSeated, 0);
    assert.ok(last.driverVisible);
  }
});

test('parked and mission vehicles retain immediate entry and cars beyond reach or excessive speed cannot be seized', () => {
  const sim = new Simulation();
  for (const id of ['courier-01', 'parked-coral']) {
    const car = sim.state.vehicles.find(vehicle => vehicle.id === id)!;
    Object.assign(sim.state.player, { x: car.x + Math.cos(car.yaw) * 2.1, z: car.z - Math.sin(car.yaw) * 2.1, vehicleId: null });
    sim.interact();
    assert.equal(sim.state.player.vehicleId, car.id);
    assert.equal(sim.state.carjacking, null);
  }
  for (const blocked of ['speed', 'distance'] as const) {
    const { sim: isolated, car } = scene();
    if (blocked === 'speed') car.speed = 13;
    else Object.assign(isolated.state.player, { x: 20, z: 20 });
    isolated.interact();
    assert.equal(isolated.state.carjacking, null);
    assert.equal(isolated.state.player.vehicleId, null);
    assert.ok(car.driver);
  }
});
