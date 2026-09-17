import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { Building } from '../src/game/types.ts';
import { CameraRig } from '../src/render/CameraRig.ts';

function setup(buildings: Building[] = []) {
  const camera = new THREE.PerspectiveCamera(55, 1, .18, 740);
  const rig = new CameraRig(camera, buildings);
  rig.update({ x: 0, z: 0 }, false, 0, 0);
  return { camera, rig };
}

function assertMovementMatchesView(camera: THREE.Camera, rig: CameraRig) {
  const view = camera.getWorldDirection(new THREE.Vector3());
  const groundDirection = new THREE.Vector2(view.x, view.z).normalize();
  assert.ok(groundDirection.distanceTo(new THREE.Vector2(Math.sin(rig.getMovementYaw()), Math.cos(rig.getMovementYaw()))) < 1e-10);
}

const wall: Building = {
  id: 'wall', kind: 'building', x: 0, z: 6, width: 40, depth: 2,
  height: 30, yaw: 0, color: '#ffffff', style: 0,
};

test('air-support framing eases in, pauses, restores, and yields immediately to vertical mouse input', () => {
  const { camera, rig } = setup();
  const yaw = rig.getMovementYaw(), target = { x: 0, z: 0 };
  rig.update(target, true, 20, 1 / 60, { airSupport: true });
  assert.ok(rig.getPitch() < .42 && rig.getPitch() > .39, 'no sudden camera tilt');
  for (let n = 0; n < 180; n++) rig.update(target, true, 20, 1 / 60, { airSupport: true });
  assert.ok(Math.abs(rig.getPitch() - .05) < .001);
  const paused = camera.quaternion.clone(), pausedPosition = camera.position.clone();
  rig.update(target, true, 20, 0, { airSupport: true });
  assert.ok(camera.quaternion.angleTo(paused) < 1e-7 && camera.position.distanceTo(pausedPosition) < 1e-10);
  for (let n = 0; n < 180; n++) rig.update(target, true, 20, 1 / 60);
  assert.ok(Math.abs(rig.getPitch() - .42) < .001, 'normal view returns after air support leaves');
  for (let n = 0; n < 180; n++) rig.update(target, false, 0, 1 / 60, { airSupport: true });
  const beforeMouse = rig.getPitch();
  rig.look(0, 80);
  assert.ok(Math.abs(rig.getPitch() - beforeMouse - .2) < 1e-10);
  const manualPitch = rig.getPitch();
  for (let n = 0; n < 120; n++) rig.update(target, false, 0, 1 / 60, { airSupport: true });
  assert.equal(rig.getPitch(), manualPitch, 'framing must not fight the mouse');
  assert.equal(rig.getMovementYaw(), yaw);
  assertMovementMatchesView(camera, rig);
});

test('air-support framing does not alter first-person eyes or firearm aiming', () => {
  const { camera, rig } = setup();
  const target = { x: 0, z: 0 };
  for (let n = 0; n < 120; n++) rig.update(target, false, 0, 1 / 60, { airSupport: true });
  rig.setCombat(true, true);
  rig.update(target, false, 0, 1 / 60, { airSupport: true });
  assert.equal(rig.getPitch(), .02);
  const aim = camera.quaternion.clone();
  for (let n = 0; n < 120; n++) rig.update(target, false, 0, 1 / 60, { airSupport: true });
  assert.ok(camera.quaternion.angleTo(aim) < 1e-7);
  rig.setCombat(false); rig.togglePerspective();
  rig.update(target, true, 20, 1 / 60, { eyeHeight: 1.72, vehicleYaw: 0, airSupport: true });
  assert.equal(rig.getPitch(), 0);
  assert.equal(camera.position.y, 1.72);
  assertMovementMatchesView(camera, rig);
});

test('mouse right turns toward screen right and mouse down looks down', () => {
  const { camera, rig } = setup();
  const initial = camera.getWorldDirection(new THREE.Vector3());
  const screenRight = new THREE.Vector3().crossVectors(initial, camera.up).normalize();
  rig.look(180, 100);
  rig.update({ x: 0, z: 0 }, false, 0, 1 / 60);
  const turned = camera.getWorldDirection(new THREE.Vector3());
  assert.ok(turned.dot(screenRight) > .2);
  assert.ok(turned.y < initial.y);
  assertMovementMatchesView(camera, rig);
});

test('many full mouse orbits keep finite wrapped yaw and match the rendered direction', () => {
  const { camera, rig } = setup();
  for (let i = 0; i < 500; i++) {
    rig.look(173, i % 2 ? -20 : 20);
    rig.update({ x: 0, z: 0 }, false, 0, 1 / 60);
    assert.ok(Math.abs(rig.getMovementYaw()) <= Math.PI);
    assertMovementMatchesView(camera, rig);
  }
  const yaw = rig.getMovementYaw();
  rig.look(Number.NaN, Number.POSITIVE_INFINITY);
  assert.equal(rig.getMovementYaw(), yaw);
});

test('vertical mouse limits avoid inversion and keep both camera modes above the road', () => {
  const { camera, rig } = setup();
  for (const deltaY of [-1e6, 1e6]) {
    rig.look(0, deltaY);
    for (const driving of [false, true]) {
      for (let mode = 0; mode < 2; mode++) {
        rig.cycleCamera();
        rig.update({ x: 0, z: 0 }, driving, 30, 1);
        const view = camera.getWorldDirection(new THREE.Vector3());
        assert.ok(camera.position.y >= .4 - 1e-10);
        assert.ok(Math.hypot(view.x, view.z) > .3, 'the view cannot flip over its vertical pole');
        assert.ok(deltaY < 0 ? view.y > 0 && view.y < .2 : view.y < -.9);
        assertMovementMatchesView(camera, rig);
      }
    }
  }
});

test('vehicle turns, entry, exit and C camera mode preserve the mouse-selected view', () => {
  const { camera, rig } = setup();
  rig.look(290, -60);
  rig.update({ x: 0, z: 0 }, false, 0, 1 / 60);
  const orientation = camera.quaternion.clone();
  const target = { x: 0, z: 0, yaw: Math.PI };
  for (let i = 0; i < 120; i++) {
    target.x += .2;
    target.z -= .1;
    target.yaw += .1;
    if (i === 50 || i === 100) rig.cycleCamera();
    rig.update(target, i >= 20 && i < 90, 20, 1 / 60);
    assert.ok(camera.quaternion.angleTo(orientation) < 1e-7);
    assertMovementMatchesView(camera, rig);
  }
});

test('a wall shortens the boom without changing direction and recovery eases outward', () => {
  const { camera, rig } = setup([wall]);
  const focus = new THREE.Vector3(0, 1.6, 0);
  const obstructedDistance = camera.position.distanceTo(focus);
  assert.ok(obstructedDistance > 4 && obstructedDistance < 6);
  assert.ok(Math.abs(camera.position.x) < 1e-10);
  assert.ok(camera.position.z < 4.82);
  assertMovementMatchesView(camera, rig);

  rig.look(Math.PI / .0025, 0);
  rig.update({ x: 0, z: 0 }, false, 0, 1 / 60);
  const recoveringDistance = camera.position.distanceTo(focus);
  assert.ok(recoveringDistance > obstructedDistance && recoveringDistance < 23);
  assertMovementMatchesView(camera, rig);
  for (let i = 0; i < 120; i++) rig.update({ x: 0, z: 0 }, false, 0, 1 / 60);
  assert.ok(camera.position.distanceTo(focus) > 22.9);

  rig.look(-Math.PI / .0025, 0);
  rig.update({ x: 0, z: 0 }, false, 0, 1 / 60);
  assert.ok(camera.position.z < 4.82, 'the camera must retract in the same frame');
  assert.ok(Math.abs(camera.position.distanceTo(focus) - obstructedDistance) < 1e-8);
  assertMovementMatchesView(camera, rig);
});

test('orbiting a building corner never cuts the camera segment through the building', () => {
  const building = { ...wall, x: 5, z: 6, width: 4, depth: 4 };
  const { camera, rig } = setup([building]);
  const box = new THREE.Box3(new THREE.Vector3(3, -.5, 4), new THREE.Vector3(7, 31.2, 8));
  const focus = new THREE.Vector3(0, 1.6, 0);
  for (let i = 0; i < 360; i++) {
    rig.look(-Math.PI / 180 / .0025, 0);
    rig.update({ x: 0, z: 0 }, false, 0, 1 / 60);
    const ray = new THREE.Ray(focus, camera.position.clone().sub(focus).normalize());
    const hit = ray.intersectBox(box, new THREE.Vector3());
    assert.ok(!hit || hit.distanceTo(focus) > camera.position.distanceTo(focus));
    assertMovementMatchesView(camera, rig);
  }
});

test('firearm equip and RMB prepare a shoulder view whose center ray follows the mouse immediately', () => {
  const { camera, rig } = setup();
  rig.setCombat(true);
  rig.update({ x: 0, z: 0 }, false, 0, 0);
  assert.ok(camera.position.x > .6 && camera.position.x < .8, 'the avatar appears left of the crosshair');
  assert.ok(camera.position.z > 4 && camera.position.z < 5);
  assert.ok(Math.abs(rig.getPitch()) < .03, 'first equip starts at chest level');
  rig.look(80, -35);
  rig.update({ x: 0, z: 0 }, false, 0, 0);
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const center = camera.position.clone().addScaledVector(direction, 50).project(camera);
  assert.ok(Math.hypot(center.x, center.y) < 1e-8, 'shots use the exact screen center despite the shoulder offset');
  const pitch = rig.getPitch(), yaw = rig.getMovementYaw();
  const hipDistance = camera.position.distanceTo(new THREE.Vector3(0, 1.6, 0));
  rig.setCombat(true, true);
  rig.update({ x: 0, z: 0 }, false, 0, 0);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(0, 1.6, 0)) < hipDistance);
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(direction) < 1e-8);
  assertMovementMatchesView(camera, rig);
  rig.setCombat(false);
  rig.update({ x: 0, z: 0 }, true, 0, 1 / 60);
  assert.equal(rig.getPitch(), .42, 'driving and knife view retain their earlier pitch');
  assert.equal(rig.getMovementYaw(), yaw);
  rig.setCombat(true);
  assert.equal(rig.getPitch(), pitch, 'returning to a firearm restores its chosen pitch');
});

test('the shoulder offset retracts at walls while preserving crosshair and movement direction', () => {
  const building = { ...wall, z: 3 };
  const { camera, rig } = setup([building]);
  const box = new THREE.Box3(new THREE.Vector3(-20, -.5, 2), new THREE.Vector3(20, 31.2, 4));
  const focus = new THREE.Vector3(0, 1.6, 0);
  rig.setCombat(true);
  for (let i = 0; i < 180; i++) {
    rig.look(12, 0);
    rig.setCombat(true, i > 90);
    rig.update({ x: 0, z: 0 }, false, 0, 1 / 60);
    const ray = new THREE.Ray(focus, camera.position.clone().sub(focus).normalize());
    const hit = ray.intersectBox(box, new THREE.Vector3());
    assert.ok(!hit || hit.distanceTo(focus) > camera.position.distanceTo(focus));
    assertMovementMatchesView(camera, rig);
  }
});

test('first person starts level and follows the exact eye position during zero-dt preparation and teleports', () => {
  const { camera, rig } = setup([wall]);
  const yaw = rig.getMovementYaw();
  assert.match(rig.togglePerspective(), /First-person/);
  assert.equal(rig.isFirstPerson(), true);
  for (const target of [{ x: 0, z: 0 }, { x: 72, z: -83 }, { x: -91, z: 125 }]) {
    rig.update(target, false, 0, 0, { eyeHeight: 2.102 });
    assert.ok(camera.position.distanceTo(new THREE.Vector3(target.x, 2.102, target.z)) < 1e-12);
    assert.ok(Math.abs(camera.getWorldDirection(new THREE.Vector3()).y) < 1e-12);
    assert.equal(rig.getMovementYaw(), yaw);
    assertMovementMatchesView(camera, rig);
  }
  assert.equal(camera.near, .035);
  assert.equal(camera.fov, 75);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const projected = camera.position.clone().addScaledVector(forward, 25).project(camera);
  assert.ok(Math.hypot(projected.x, projected.y) < 1e-10, 'same-tick eye position and orientation define the screen center');
});

test('first-person vertical look avoids inversion and C preserves the remembered third-person distance', () => {
  const { camera, rig } = setup();
  assert.equal(rig.cycleCamera(), 'Scenic camera');
  rig.togglePerspective();
  rig.update({ x: 3, z: 4 }, false, 0, 0);
  const beforeC = camera.position.clone(), beforeOrientation = camera.quaternion.clone();
  assert.match(rig.cycleCamera(), /press V/);
  rig.update({ x: 3, z: 4 }, false, 0, 0);
  assert.ok(camera.position.distanceTo(beforeC) < 1e-12);
  assert.ok(camera.quaternion.angleTo(beforeOrientation) < 1e-7);
  for (const delta of [-1e6, 1e6]) {
    rig.look(95, delta);
    rig.update({ x: 3, z: 4 }, false, 0, 0);
    const direction = camera.getWorldDirection(new THREE.Vector3());
    assert.ok(Math.hypot(direction.x, direction.z) > .16, 'mouse look cannot cross a vertical pole');
    assert.ok(delta < 0 ? direction.y > .98 : direction.y < -.98);
    assertMovementMatchesView(camera, rig);
  }
  assert.match(rig.togglePerspective(), /Third-person/);
  rig.update({ x: 3, z: 4 }, false, 0, 0);
  assert.ok(Math.abs(camera.position.distanceTo(new THREE.Vector3(3, 1.6, 4)) - 46) < 1e-9);
  assert.equal(rig.getPitch(), .42);
  assert.equal(camera.near, .18);
  assert.equal(camera.fov, 55);
});

test('FPS equipment and ADS retain the center direction and preserve both third-person pitch memories', () => {
  const { camera, rig } = setup();
  rig.look(0, 60);
  const streetPitch = rig.getPitch();
  rig.setCombat(true);
  rig.look(0, -80);
  const firearmPitch = rig.getPitch();
  rig.togglePerspective();
  assert.equal(rig.getPitch(), 0, 'first FPS use starts level even when the shoulder camera looks up');
  rig.look(74, 120);
  rig.update({ x: 0, z: 0 }, false, 0, 0);
  const firstPitch = rig.getPitch();
  const direction = camera.getWorldDirection(new THREE.Vector3()), eye = camera.position.clone();
  for (const [active, aiming] of [[false, false], [true, false], [true, true], [false, false]]) {
    rig.setCombat(active, aiming);
    rig.update({ x: 0, z: 0 }, false, 0, 0);
    assert.equal(rig.getPitch(), firstPitch);
    assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(direction) < 1e-10);
    assert.ok(camera.position.distanceTo(eye) < 1e-12);
    assert.equal(camera.fov, active && aiming ? 58 : 75);
    const center = camera.position.clone().addScaledVector(direction, 40).project(camera);
    assert.ok(Math.hypot(center.x, center.y) < 1e-10);
  }
  rig.setCombat(true);
  rig.togglePerspective();
  assert.equal(rig.getPitch(), firearmPitch);
  rig.setCombat(false);
  assert.equal(rig.getPitch(), streetPitch);
  rig.togglePerspective();
  assert.equal(rig.getPitch(), firstPitch, 'later FPS use restores its own chosen look angle');
});

test('driver eye rotates with the seat while mouse look stays relative across wrapped vehicle headings', () => {
  const { camera, rig } = setup();
  rig.togglePerspective();
  const target = { x: 20, z: -8, yaw: 3.05 };
  const seat = { x: .39, y: 1.84, z: .11 };
  rig.update(target, true, 20, 0, { vehicleYaw: target.yaw, seatOffset: seat });
  assert.ok(Math.abs(rig.getMovementYaw() - target.yaw) < 1e-12);
  assert.equal(rig.getPitch(), 0);
  rig.look(200, 80);
  for (let frame = 0; frame < 90; frame++) {
    target.yaw += .13; target.x += .4; target.z -= .2;
    rig.update(target, true, 24, 0, { vehicleYaw: target.yaw, seatOffset: seat });
    const expectedEye = new THREE.Vector3(
      target.x + Math.cos(target.yaw) * seat.x + Math.sin(target.yaw) * seat.z,
      seat.y,
      target.z - Math.sin(target.yaw) * seat.x + Math.cos(target.yaw) * seat.z,
    );
    assert.ok(camera.position.distanceTo(expectedEye) < 1e-10);
    const expectedYaw = Math.atan2(Math.sin(target.yaw - .5), Math.cos(target.yaw - .5));
    assert.ok(Math.abs(rig.getMovementYaw() - expectedYaw) < 1e-10);
    assert.equal(rig.getPitch(), .2);
    assert.equal(camera.fov, 72);
    assertMovementMatchesView(camera, rig);
  }
  rig.update(target, true, 0, 0, { vehicleYaw: target.yaw, seatOffset: seat, eyeHeight: 2.2 });
  assert.equal(camera.position.y, 2.2, 'explicit world eye height overrides the seat default');
});

test('driver look is bounded, exiting preserves world look, and entering another car aligns forward', () => {
  const { camera, rig } = setup();
  rig.togglePerspective();
  rig.update({ x: 0, z: 0 }, true, 0, 0, { vehicleYaw: .8 });
  rig.look(1e6, -1e6);
  rig.update({ x: 1, z: 2 }, true, 10, 0, { vehicleYaw: .9 });
  assert.ok(Math.abs(rig.getMovementYaw() - (.9 - 1.9)) < 1e-12);
  assert.equal(rig.getPitch(), -1.1);
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const yaw = rig.getMovementYaw(), pitch = rig.getPitch();
  const foot = { x: 2.5, z: 2, yaw: 2.7 };
  rig.update(foot, false, 0, 0, { eyeHeight: 2.15 });
  assert.equal(rig.getMovementYaw(), yaw);
  assert.equal(rig.getPitch(), pitch);
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(direction) < 1e-10);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(foot.x, 2.15, foot.z)) < 1e-12);
  assert.equal(camera.fov, 75);
  rig.look(800, 0);
  rig.update(foot, false, 0, 0);
  assert.ok(Math.abs(rig.getMovementYaw() - yaw) > 1.9, 'on-foot mouse yaw is no longer clamped to the old car');
  rig.update({ x: 16, z: -12 }, true, 0, 0, { vehicleYaw: -2.6 });
  assert.ok(Math.abs(rig.getMovementYaw() + 2.6) < 1e-12);
  assert.equal(rig.getPitch(), 0);
  assertMovementMatchesView(camera, rig);
});

test('V in a moving third-person car enters forward-facing FPS and returns without a stale boom', () => {
  const { camera, rig } = setup();
  rig.look(270, 30);
  const streetPitch = rig.getPitch();
  const target = { x: 40, z: 10, yaw: Math.PI / 2 };
  rig.update(target, true, 20, 1 / 60);
  const freeYaw = rig.getMovementYaw();
  assert.match(rig.togglePerspective(), /driver/);
  rig.update(target, true, 20, 0);
  assert.ok(Math.abs(rig.getMovementYaw() - target.yaw) < 1e-12);
  assert.notEqual(rig.getMovementYaw(), freeYaw);
  rig.look(140, -90);
  rig.update(target, true, 20, 0);
  const leavingYaw = rig.getMovementYaw();
  rig.togglePerspective();
  rig.update(target, true, 20, 0);
  assert.equal(rig.getPitch(), streetPitch);
  assert.equal(rig.getMovementYaw(), leavingYaw);
  assert.ok(Math.abs(camera.position.distanceTo(new THREE.Vector3(target.x, 1.65, target.z)) - 26.8) < 1e-9);
  const thirdDirection = camera.getWorldDirection(new THREE.Vector3());
  target.yaw += .75;
  rig.update(target, true, 20, 1 / 60);
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(thirdDirection) < 1e-10, 'third-person car turns still preserve free mouse look');
  rig.togglePerspective();
  rig.update(target, true, 20, 0);
  assert.ok(Math.abs(rig.getMovementYaw() - target.yaw) < 1e-12);
});

test('invalid optional seat and mouse values cannot corrupt the first-person camera', () => {
  const { camera, rig } = setup();
  rig.togglePerspective();
  rig.update({ x: 1, z: 2 }, true, 0, 0, {
    vehicleYaw: Number.POSITIVE_INFINITY, eyeHeight: Number.NaN,
    seatOffset: { x: Number.NaN, y: Number.NEGATIVE_INFINITY, z: Number.POSITIVE_INFINITY },
  });
  assert.ok(camera.position.distanceTo(new THREE.Vector3(1.36, 1.65, 2.05)) < 1e-12, 'the default driver seat is anatomical left (+X)');
  const direction = camera.getWorldDirection(new THREE.Vector3());
  rig.look(Number.NaN, Number.POSITIVE_INFINITY);
  rig.update({ x: 1, z: 2 }, true, 0, 0, { vehicleYaw: Number.NaN });
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(direction) < 1e-10);
  assert.ok([...camera.projectionMatrix.elements, ...camera.matrixWorld.elements].every(Number.isFinite));
  rig.update({ x: 1, z: 2 }, false, 0, 0, { eyeHeight: Number.NaN });
  assert.equal(camera.position.y, 2.05);
});
