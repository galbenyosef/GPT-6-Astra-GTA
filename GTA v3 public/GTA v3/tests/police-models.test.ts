import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import * as THREE from 'three';
import { createVehicles } from '../src/game/ai';
import { VEHICLE_SPECS } from '../src/game/vehicles';
import { helicopterGunPose } from '../src/game/policeHelicopter';
import type { PoliceHelicopter } from '../src/game/types';
import { createArmoredVehicle, createPoliceHelicopter } from '../src/render/PoliceModels';
import { createVehicleCockpit } from '../src/render/VehicleCockpit';
import { createCabinGeometry, createVehicleModel, type Shape, type VehiclePart } from '../src/render/VehicleModels';

const geometries: Record<Shape, THREE.BufferGeometry> = {
  box: new THREE.BoxGeometry(1, 1, 1), cylinder: new THREE.CylinderGeometry(1, 1, 1, 8),
  sphere: new THREE.SphereGeometry(1, 9, 6), cone: new THREE.ConeGeometry(1, 1, 5), cabin: createCabinGeometry(),
};
const material = new THREE.MeshBasicMaterial();
const part: VehiclePart = (parent, shape, _color, x, y, z, sx, sy, sz, yaw = 0) => {
  const mesh = new THREE.Mesh(geometries[shape], material);
  mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.rotation.y = yaw; parent.add(mesh); return mesh;
};
const armoredVehicle = () => ({ ...createVehicles()[0], ...VEHICLE_SPECS.armored, model: 'armored' as const, kind: 'police' as const });
after(() => { Object.values(geometries).forEach(geometry => geometry.dispose()); material.dispose(); });

test('armored carrier stays inside its collider at every wheel steering/rolling pose', () => {
  const vehicle = armoredVehicle(), node = createVehicleModel(vehicle, part);
  assert.equal(node.wheels.length, 6);
  assert.equal(node.frontWheels.length, 2);
  assert.equal(new Set(node.wheels.map(wheel => wheel.parent)).size, 6);
  assert.ok(node.frontWheels.every(wheel => wheel.position.z > 2));
  assert.ok(node.leftLight && node.rightLight && node.leftLight !== node.rightLight);
  for (const steer of [-.58 * .36, 0, .58 * .36]) for (const roll of [0, Math.PI / 8, Math.PI / 3, Math.PI / 2]) {
    node.frontWheels.forEach(wheel => { wheel.rotation.y = steer; });
    node.wheels.forEach(wheel => { wheel.rotation.x = roll; });
    const bounds = new THREE.Box3().setFromObject(node.root, true);
    assert.ok(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)) <= vehicle.width / 2 + 1e-6);
    assert.ok(Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)) <= vehicle.depth / 2 + 1e-6);
    assert.ok(bounds.min.y >= 0, 'rolling wheels stay above the road surface');
    assert.ok(bounds.max.y > 3.5, 'antenna and raised troop compartment give the carrier a tall silhouette');
  }
  node.root.updateMatrixWorld(true);
  const rearDoors: THREE.Object3D[] = [];
  node.root.traverse(object => { if (object.name === 'rear-egress-door') rearDoors.push(object); });
  assert.equal(rearDoors.length, 2);
  assert.ok(rearDoors.every(door => door.position.z < -3), 'troops have rear egress doors');
});

test('helicopter rotors spin independently without moving its fuselage, tail or gun', () => {
  const node = createPoliceHelicopter(part);
  const fixedNames = ['helicopter-fuselage', 'tapered-tail-boom', 'vertical-tail-fin', 'helicopter-gun'];
  node.root.updateMatrixWorld(true);
  const before = fixedNames.map(name => node.root.getObjectByName(name)!.matrixWorld.clone());
  const mainBlade = node.mainRotor.getObjectByName('rotor-tip')!;
  const tailBlade = node.tailRotor.getObjectByName('tail-rotor-tip')!;
  const mainBefore = mainBlade.getWorldPosition(new THREE.Vector3());
  const tailBefore = tailBlade.getWorldPosition(new THREE.Vector3());
  node.mainRotor.rotation.y = .77; node.tailRotor.rotation.x = 1.31;
  node.root.updateMatrixWorld(true);
  assert.ok(mainBlade.getWorldPosition(new THREE.Vector3()).distanceTo(mainBefore) > 3);
  assert.ok(tailBlade.getWorldPosition(new THREE.Vector3()).distanceTo(tailBefore) > 1);
  fixedNames.forEach((name, index) => assert.deepEqual(node.root.getObjectByName(name)!.matrixWorld.elements, before[index].elements));
  const fuselage = new THREE.Box3().setFromObject(node.root.getObjectByName('helicopter-fuselage')!, true);
  const rotor = new THREE.Box3().setFromObject(node.mainRotor, true);
  assert.ok(rotor.min.y > fuselage.max.y + .5, 'the rotor clears the cabin');
  const skids: THREE.Object3D[] = [];
  node.root.traverse(object => { if (object.name === 'landing-skid') skids.push(object); });
  assert.equal(skids.length, 2);
  assert.ok(skids.every(skid => new THREE.Box3().setFromObject(skid, true).min.y >= -1.31));
});

test('helicopter gun and muzzle match the simulation aim at arbitrary hull and turret headings', () => {
  const node = createPoliceHelicopter(part);
  const helicopter: PoliceHelicopter = { x: -194, y: 42, z: 310, yaw: 0, rotor: 0, fireCooldown: 0,
    burst: 0, spawnedAt: 0, lastFireAt: 0, visible: true };
  node.root.position.set(helicopter.x, helicopter.y, helicopter.z);
  const targets = [{ x: -200, y: 1.3, z: 320 }, { x: 80, y: 1.5, z: -190 }, { x: -194, y: 0, z: 310 }];
  for (const yaw of [-2.3, 0, 1.7]) for (const target of targets) {
    helicopter.yaw = yaw;
    const pose = helicopterGunPose(helicopter, target);
    // This is the exact transform order applied by GameRenderer.updateHelicopter.
    node.root.rotation.y = yaw; node.gun.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
    node.root.updateMatrixWorld(true);
    const expected = new THREE.Vector3(pose.muzzle.x, pose.muzzle.y, pose.muzzle.z);
    assert.ok(node.muzzle.getWorldPosition(new THREE.Vector3()).distanceTo(expected) < 1e-8);
    const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(node.gun.getWorldQuaternion(new THREE.Quaternion()));
    const expectedDirection = new THREE.Vector3(target.x - pose.base.x, target.y - pose.base.y, target.z - pose.base.z).normalize();
    assert.ok(direction.distanceTo(expectedDirection) < 1e-8);
    const muzzleToTarget = new THREE.Vector3(target.x, target.y, target.z).sub(node.muzzle.getWorldPosition(new THREE.Vector3())).normalize();
    assert.ok(direction.distanceTo(muzzleToTarget) < 1e-8, 'the barrel points along the actual hitscan ray');
  }
});

test('police reinforcements use only shared cached geometry and finite transforms', () => {
  const cached = new Set(Object.values(geometries));
  const roots = [createArmoredVehicle(armoredVehicle(), part).root, createPoliceHelicopter(part).root];
  for (const root of roots) {
    root.updateMatrixWorld(true);
    let meshes = 0;
    root.traverse(object => {
      assert.ok(object.matrixWorld.elements.every(Number.isFinite));
      if (object instanceof THREE.Mesh) {
        meshes++;
        assert.ok(cached.has(object.geometry));
        assert.ok(object.scale.toArray().every(scale => scale > 0));
      }
    });
    assert.ok(meshes > 80 && meshes < 300, `${root.name}: ${meshes} meshes should give a detailed bounded model`);
  }
});

test('armored cockpit has a safe eye and an unobstructed forward sightline', () => {
  const vehicle = armoredVehicle(), node = createVehicleCockpit(vehicle, part);
  const eye = new THREE.Vector3(node.seatOffset.x, node.seatOffset.y, node.seatOffset.z);
  node.root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(node.root, true);
  assert.ok(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)) <= vehicle.width / 2);
  assert.ok(Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)) <= vehicle.depth / 2);
  node.root.traverse(object => {
    if (object instanceof THREE.Mesh) assert.ok(!new THREE.Box3().setFromObject(object, true).expandByScalar(.04).containsPoint(eye));
  });
  for (const yaw of [-.16, 0, .16]) for (const pitch of [-.04, 0, .04, .28]) {
    const direction = new THREE.Vector3(Math.sin(yaw), Math.sin(pitch), Math.cos(yaw)).normalize();
    const hits = new THREE.Raycaster(eye, direction, .04, 20).intersectObject(node.root, true);
    assert.equal(hits.length, 0, `armored road sightline must not hit ${hits[0]?.object.name}`);
  }
});
