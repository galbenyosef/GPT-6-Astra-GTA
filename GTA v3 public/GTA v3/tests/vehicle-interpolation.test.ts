import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Simulation } from '../src/game/simulation.ts';
import { CameraRig } from '../src/render/CameraRig.ts';
import { VehicleInterpolation } from '../src/render/VehicleInterpolation.ts';

function setup() {
  const simulation = new Simulation();
  const state = simulation.state;
  const car = state.vehicles.find(vehicle => vehicle.id === 'courier-01')!;
  Object.assign(car, { x: 0, z: 0, yaw: Math.PI, speed: 24, steer: 0, active: true });
  state.player.vehicleId = car.id;
  state.vehicles = [car];
  const interpolation = new VehicleInterpolation();
  return { state, car, interpolation };
}

test('rendered vehicles interpolate between fixed steps without changing physics state', () => {
  const { state, car, interpolation } = setup();
  interpolation.capture(state);
  Object.assign(car, { x: .4, z: -.8, speed: 20, steer: .4 });
  const authoritative = structuredClone(state);
  const display = interpolation.sample(state, .25)[0];
  assert.equal(display.x, .1);
  assert.equal(display.z, -.2);
  assert.equal(display.speed, 23);
  assert.equal(display.steer, .1);
  assert.deepEqual(state, authoritative);
  assert.equal(interpolation.sample(state, 0)[0].x, 0);
  assert.equal(interpolation.sample(state, 1)[0].x, .4);
});

test('heading interpolation crosses angle wrap by the short path', () => {
  const { state, car, interpolation } = setup();
  for (const [from, to, expected] of [[Math.PI - .1, -Math.PI + .1, Math.PI], [Math.PI * 2 - .1, .1, Math.PI * 2]]) {
    car.yaw = from;
    interpolation.capture(state);
    car.yaw = to;
    assert.ok(Math.abs(interpolation.sample(state, .5)[0].yaw - expected) < 1e-12);
  }
});

test('multiple physics updates retain the last pair, not the previous render frame', () => {
  const { state, car, interpolation } = setup();
  for (let step = 0; step < 3; step++) {
    interpolation.capture(state);
    car.x += .4;
  }
  assert.ok(Math.abs(interpolation.sample(state, .5)[0].x - 1) < 1e-12);
  const frozen = interpolation.sample(state, .5);
  for (let frame = 0; frame < 20; frame++) assert.deepEqual(interpolation.sample(state, .5), frozen, 'paused render frames do not advance the pose');
});

test('new, reactivated, teleported and entered vehicles snap instead of sweeping through the city', () => {
  const { state, car, interpolation } = setup();
  assert.equal(interpolation.sample(state, 0)[0], car);
  interpolation.capture(state);
  car.x = 50;
  assert.equal(interpolation.sample(state, .5)[0].x, 50);
  car.active = false;
  interpolation.capture(state);
  car.active = true; car.x += .4;
  assert.equal(interpolation.sample(state, 0)[0], car);
  state.player.vehicleId = null;
  interpolation.capture(state);
  state.player.vehicleId = car.id;
  car.x += .4;
  assert.equal(interpolation.sample(state, 0)[0], car);
  state.vehicles = [];
  interpolation.capture(state);
  state.vehicles = [car];
  assert.equal(interpolation.sample(state, 0)[0], car);
});

test('invalid blend values never extrapolate past a collision or stop', () => {
  const { state, car, interpolation } = setup();
  interpolation.capture(state);
  car.x = .4; car.speed = 0;
  for (const alpha of [-2, 0, .2, 1, 4, NaN, Infinity]) {
    const display = interpolation.sample(state, alpha)[0];
    assert.ok(display.x >= 0 && display.x <= car.x);
    assert.ok(display.speed >= 0 && display.speed <= 24);
  }
  interpolation.capture(state);
  for (const alpha of [0, .4, 1]) assert.equal(interpolation.sample(state, alpha)[0].x, .4);
});

test('a car drives continuously and stays stable on screen at different and uneven frame rates', () => {
  const schedules = [30, 60, 75, 90, 120, 144, 165].map(rate => [1 / rate]);
  schedules.push([1 / 144, 1 / 144, 1 / 90, 1 / 60, 1 / 120, 1 / 75]);
  for (const schedule of schedules) {
    const { state, car, interpolation } = setup();
    const camera = new THREE.PerspectiveCamera(55, 1, .18, 740);
    const rig = new CameraRig(camera, []);
    let accumulator = 0, elapsed = 0;
    let previousZ = 0, previousScreenY = 0;
    for (let frame = 0; frame < 400; frame++) {
      const dt = schedule[frame % schedule.length];
      accumulator += dt; elapsed += dt;
      while (accumulator + 1e-12 >= 1 / 60) {
        interpolation.capture(state);
        car.z -= car.speed / 60;
        accumulator -= 1 / 60;
      }
      const display = interpolation.sample(state, accumulator * 60)[0];
      rig.update(display, true, display.speed, dt);
      camera.updateMatrixWorld();
      const screenY = new THREE.Vector3(display.x, 1.1, display.z).project(camera).y * 450;
      if (frame > 5) {
        assert.ok(Math.abs(display.z - previousZ + car.speed * dt) < 1e-8, `stepped movement at ${schedule}`);
        assert.ok(Math.abs(screenY - previousScreenY) < 1e-8, `third-person jitter at ${schedule}`);
        assert.ok(Math.abs(display.z + car.speed * (elapsed - 1 / 60)) < 1e-8);
      }
      previousZ = display.z; previousScreenY = screenY;
    }
  }
});

test('the cockpit and driver camera can share the same interpolated position and wrapped yaw', () => {
  const { state, car, interpolation } = setup();
  interpolation.capture(state);
  car.x += .4; car.z -= .3; car.yaw += .04;
  const camera = new THREE.PerspectiveCamera(55, 1, .18, 740);
  const rig = new CameraRig(camera, []);
  rig.togglePerspective();
  const seat = { x: .36, y: 1.65, z: .05 };
  for (const alpha of [0, .25, .5, .75, 1]) {
    const display = interpolation.sample(state, alpha)[0];
    rig.update(display, true, display.speed, 1 / 144, { vehicleYaw: display.yaw, seatOffset: seat });
    const cockpit = new THREE.Object3D();
    cockpit.position.set(display.x, 0, display.z); cockpit.rotation.y = display.yaw;
    assert.ok(camera.position.distanceTo(cockpit.localToWorld(new THREE.Vector3(seat.x, seat.y, seat.z))) < 1e-10);
  }
});
