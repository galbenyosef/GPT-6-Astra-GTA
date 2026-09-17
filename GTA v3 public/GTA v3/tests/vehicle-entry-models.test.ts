import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import * as THREE from 'three';
import { createVehicles } from '../src/game/ai';
import { VEHICLE_CABINS, getVehicleAccess } from '../src/game/vehicleAccess';
import { VEHICLE_SPECS } from '../src/game/vehicles';
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
after(() => { Object.values(geometries).forEach(geometry => geometry.dispose()); material.dispose(); });
const visibleMeshes = (root: THREE.Object3D) => {
  const meshes: THREE.Mesh[] = [];
  root.traverseVisible(object => { if (object instanceof THREE.Mesh) meshes.push(object); });
  return meshes;
};

for (const model of ['sedan', 'truck', 'pickup', 'hatchback', 'sport'] as const) {
  test(`${model} driver door exposes a real aperture, moves its handle, and closes inside its collider`, () => {
    const vehicle = createVehicles().find(car => car.model === model)!;
    const node = createVehicleModel(vehicle, part), entry = node.entry!;
    const access = getVehicleAccess(model), cabin = VEHICLE_CABINS[model];
    assert.ok(entry);
    assert.deepEqual(entry.seatEye, cabin.eye);
    assert.equal(entry.door.parent, node.root);
    assert.equal(entry.interiorRoot.children.length, 0, 'inactive cars do not construct an unused cockpit');
    node.root.updateMatrixWorld(true);
    const hingeBefore = entry.door.getWorldPosition(new THREE.Vector3());
    const handleBefore = entry.handle.getWorldPosition(new THREE.Vector3());
    const fixedMatrices = node.root.children.filter(child => child !== entry.door && child !== entry.interiorRoot).map(child => child.matrix.clone());
    const doorwayRay = (y: number, endX = access.bodyHalfWidth - .18) => new THREE.Raycaster(
      new THREE.Vector3(vehicle.width / 2 + 2, y, cabin.eye.z), new THREE.Vector3(-1, 0, 0), 0,
      vehicle.width / 2 + 2 - endX);
    assert.ok(doorwayRay(cabin.sill - .10).intersectObjects(visibleMeshes(node.root), false).length > 0, 'closed metal blocks the doorway');

    entry.setOpen(1, true); node.root.updateMatrixWorld(true);
    assert.equal(entry.door.rotation.y, -access.doorOpenAngle);
    assert.ok(entry.door.getWorldPosition(new THREE.Vector3()).distanceTo(hingeBefore) < 1e-10);
    const handleOpen = entry.handle.getWorldPosition(new THREE.Vector3());
    assert.ok(handleOpen.x > handleBefore.x + .6, 'the handle swings toward anatomical left');
    assert.ok(Math.abs(handleOpen.distanceTo(hingeBefore) - handleBefore.distanceTo(hingeBefore)) < 1e-9);
    assert.ok(entry.interiorRoot.visible);
    assert.equal(entry.interiorRoot.children.length, 1);
    assert.ok(entry.windows.every(window => !window.visible));
    for (const y of [cabin.sill - .13, cabin.sill + .05, cabin.eye.y]) {
      const hits = doorwayRay(y).intersectObjects(visibleMeshes(node.root), false);
      assert.equal(hits.length, 0, `open doorway must not retain ${hits[0]?.object.name}`);
    }
    const eyeRay = doorwayRay(cabin.eye.y, cabin.eye.x);
    assert.equal(eyeRay.intersectObjects(visibleMeshes(node.root), false).length, 0, 'the driver is visible at the seat eye through the opening');
    const stillFixed = node.root.children.filter(child => child !== entry.door && child !== entry.interiorRoot);
    stillFixed.forEach((child, index) => assert.deepEqual(child.matrix.elements, fixedMatrices[index].elements));

    const interior = entry.interiorRoot.children[0];
    for (let cycle = 0; cycle < 6; cycle++) { entry.setOpen(.45, true); entry.setOpen(0); }
    assert.equal(entry.interiorRoot.children.length, 1);
    assert.equal(entry.interiorRoot.children[0], interior, 'repeated attempts reuse the same interior');
    assert.ok(!entry.interiorRoot.visible && entry.windows.every(window => window.visible));
    node.root.updateMatrixWorld(true);
    assert.ok(entry.handle.getWorldPosition(new THREE.Vector3()).distanceTo(handleBefore) < 1e-9);
    for (const steer of [-.58 * .36, 0, .58 * .36]) for (const roll of [0, Math.PI / 8, Math.PI / 2]) {
      node.frontWheels.forEach(wheel => { wheel.rotation.y = steer; });
      node.wheels.forEach(wheel => { wheel.rotation.x = roll; });
      const bounds = new THREE.Box3().setFromObject(node.root, true);
      assert.ok(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)) <= vehicle.width / 2 + 1e-6, `${model} closed width ${bounds.min.x}..${bounds.max.x}`);
      assert.ok(Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)) <= vehicle.depth / 2 + 1e-6);
      assert.ok(bounds.min.y >= 0);
    }
    const cached = new Set(Object.values(geometries));
    node.root.traverse(object => {
      if (object instanceof THREE.Mesh) {
        assert.ok(cached.has(object.geometry));
        assert.equal(object.material, material, 'entry animation does not mutate or replace shared materials');
      }
    });
  });
}

test('door and actor access points share unscaled vehicle-local coordinates and remain independent values', () => {
  for (const model of ['sedan', 'truck', 'pickup', 'hatchback', 'sport'] as const) {
    const access = getVehicleAccess(model);
    assert.ok(access.doorWidth > 1 && access.doorWidth < 1.8);
    assert.ok(access.approach.x > VEHICLE_SPECS[model].width / 2 + .48);
    assert.ok(access.pullEnd.x > access.approach.x && access.pullEnd.z < access.approach.z);
    assert.ok(Math.abs(access.seatRoot.y + 1.99 - access.seatEye.y) < 1e-10);
    access.seatEye.x = 999;
    assert.notEqual(getVehicleAccess(model).seatEye.x, 999);
  }
  const armored = { ...createVehicles()[0], ...VEHICLE_SPECS.armored, model: 'armored' as const };
  assert.equal(createVehicleModel(armored, part).entry, undefined, 'armored police vehicles remain outside civilian entry animation');
});
