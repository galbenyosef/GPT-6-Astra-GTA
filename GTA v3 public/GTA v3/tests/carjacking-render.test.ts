import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { CameraRig, type InteractionCameraFrame } from '../src/render/CameraRig';
import { PersonModelFactory } from '../src/render/PersonModels';
import { driverCollar, maskInteractionPlayer, personEye, poseCarjackingDriver, poseCarjackingPlayer, poseRecoveringDriver, reachPersonHand } from '../src/render/CarjackingAnimation';
import { personGroundHeight } from '../src/render/PersonAnimation';
import { planCarjacking, sampleCarjacking } from '../src/game/carjacking';
import { Simulation } from '../src/game/simulation';
import { VEHICLE_CABINS, getVehicleAccess } from '../src/game/vehicleAccess';

const frame: InteractionCameraFrame = {
  eye: { x: 2, y: 1.9, z: 0 }, lookAt: { x: 0, y: 1.4, z: 0 },
  focus: { x: 1, y: 1.4, z: 0 }, thirdPosition: { x: 9, y: 4.8, z: 4 }, blend: 1,
};

test('interaction camera follows exact first-person eyes, permits V mid-action, and returns to mouse driving', () => {
  const camera = new THREE.PerspectiveCamera(55, 1, .18, 740), rig = new CameraRig(camera, []);
  rig.update({ x: 2, z: 0 }, false, 0, 0);
  rig.updateInteraction(frame);
  const third = camera.position.clone();
  rig.togglePerspective(); rig.updateInteraction(frame);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(2, 1.9, 0)) < 1e-10);
  assert.equal(camera.near, .035);
  const rotation = camera.quaternion.clone();
  rig.look(1000, 1000); rig.updateInteraction(frame);
  assert.ok(camera.quaternion.angleTo(rotation) < 1e-7, 'mouse cannot detach the camera from the scripted action');
  rig.togglePerspective(); rig.updateInteraction(frame);
  assert.ok(camera.position.distanceTo(third) < 1e-10, 'V immediately returns to the action framing');
  rig.togglePerspective(); rig.updateInteraction(frame);
  rig.update({ x: 0, z: 0 }, true, 0, 1 / 60, { vehicleYaw: .7, eyeHeight: 1.7, seatOffset: { x: .35, y: 1.7, z: .15 } });
  assert.ok(Math.abs(rig.getMovementYaw() - .7) < 1e-10);
  assert.equal(rig.getPitch(), 0);
  rig.look(120, 60);
  assert.ok(Math.abs(rig.getMovementYaw() - .7) > .2 && rig.getPitch() > .1);
});

test('third-person action framing and its transition retract in front of buildings', () => {
  const camera = new THREE.PerspectiveCamera(55, 1, .18, 740);
  const rig = new CameraRig(camera, [{ id: 'wall', kind: 'building', x: 5, z: 0, width: 1, depth: 30, height: 30, yaw: 0, color: '#fff', style: 0 }]);
  rig.update({ x: 0, z: 0 }, false, 0, 0);
  for (const blend of [.1, .5, 1]) {
    rig.updateInteraction({ ...frame, blend });
    assert.ok(camera.position.x < 4.32, 'action camera cannot cross the expanded wall boundary');
    assert.ok(camera.position.y >= .4);
    assert.ok([...camera.position.toArray(), ...camera.quaternion.toArray()].every(Number.isFinite));
  }
});

test('world-space hand IK reaches a hold under translated, rotated and scaled body transforms', () => {
  const factory = new PersonModelFactory();
  try {
    const actor = factory.create({ id: 'player', role: 'player', shirt: '#f4ebd7' });
    actor.root.position.set(8, .3, -12); actor.root.rotation.y = 1.2; actor.root.scale.setScalar(.8);
    actor.body.rotation.x = .2; actor.root.updateMatrixWorld(true);
    for (const side of ['left', 'right'] as const) {
      const arm = side === 'left' ? actor.leftArm : actor.rightArm;
      const hand = side === 'left' ? actor.leftHand : actor.rightHand;
      const hold = actor.body.localToWorld(arm.position.clone().add(new THREE.Vector3(0, -.17, .43)));
      reachPersonHand(actor, side, hold);
      assert.ok(hand.getWorldPosition(new THREE.Vector3()).distanceTo(hold) < .001);
    }
  } finally { factory.dispose(); }
});

test('all five cabins align the seated actor eyes, keep transforms finite and restore masked first-person body parts', () => {
  const factory = new PersonModelFactory();
  try {
    const player = factory.create({ id: 'player', role: 'player', shirt: '#f4ebd7' });
    const driver = factory.create({ id: 'driver', role: 'pedestrian', shirt: '#bb875c' });
    for (const model of ['sedan', 'truck', 'pickup', 'hatchback', 'sport'] as const) {
      const sim = new Simulation(), car = sim.state.vehicles.find(vehicle => vehicle.kind === 'traffic' && vehicle.model === model)!;
      const access = getVehicleAccess(model);
      Object.assign(car, { x: 0, z: 0, yaw: 0, speed: 0 });
      sim.state.vehicles = [car]; sim.state.pedestrians = []; sim.state.officers = [];
      Object.assign(sim.state.player, { x: access.approach.x, z: access.approach.z });
      const sequence = planCarjacking(sim.world, sim.state, car);
      assert.ok(sequence, `${model} has a clear entry plan`);
      const targets = { handle: access.doorHandle, leftWheel: { x: access.seatEye.x + .2, y: access.seatEye.y - .2, z: access.seatEye.z + .5 },
        rightWheel: { x: access.seatEye.x - .2, y: access.seatEye.y - .2, z: access.seatEye.z + .5 }, support: access.doorway };
      for (let elapsed = 0; elapsed < sequence.duration; elapsed += .035) {
        sequence.elapsed = elapsed;
        const sample = sampleCarjacking(sequence);
        sample.player.y += personGroundHeight(sim.world, sample.player.x, sample.player.z) * (1 - sample.playerSeated);
        sample.driver.y += personGroundHeight(sim.world, sample.driver.x, sample.driver.z) * (1 - sample.driverSeated);
        poseCarjackingDriver(driver, sample); poseCarjackingPlayer(player, sequence, sample, driver, targets);
        if (sample.phase === 'open' && sample.progress > .9) {
          const head = new THREE.Box3().setFromObject(player.head, true);
          assert.ok(head.max.y < VEHICLE_CABINS[model].roof + .12 + .05, `${model}: ducking keeps the head under the doorway roof`);
        }
        if (sample.phase === 'pull' && sample.progress > .10 && sample.progress < .90) {
          for (const side of ['left', 'right'] as const) {
            const hand = side === 'left' ? player.leftHand : player.rightHand;
            assert.ok(hand.getWorldPosition(new THREE.Vector3()).distanceTo(driverCollar(driver, side, player.root.position)) < .08,
              `${model} ${sample.progress}: the hand must stay in contact with the grabbed shirt`);
          }
        }
        for (const actor of [player, driver]) actor.root.traverse(joint => {
          assert.ok([...joint.matrixWorld.elements].every(Number.isFinite), `${model} ${sample.phase} ${joint.name}`);
        });
      }
      sequence.elapsed = sequence.duration;
      const sample = sampleCarjacking(sequence);
      poseCarjackingDriver(driver, sample); poseCarjackingPlayer(player, sequence, sample, driver, targets);
      assert.ok(personEye(player).distanceTo(new THREE.Vector3(sequence.seatEye.x, sequence.seatEye.y, sequence.seatEye.z)) < .001, `${model} final eye matches driving cockpit`);
      maskInteractionPlayer(player, true);
      assert.ok(!player.head.visible && !player.leftLeg.visible && !player.rightLeg.visible);
      assert.ok(player.leftArm.visible && player.rightArm.visible, 'the reaching arms remain visible');
      maskInteractionPlayer(player, false);
      assert.ok(player.head.visible && player.leftLeg.visible && player.rightLeg.visible);
      poseRecoveringDriver(driver, 1);
      assert.ok(Math.abs(driver.body.rotation.x) < .001 && driver.body.position.y < .001, 'recovery ends fully upright');
    }
  } finally { factory.dispose(); }
});
