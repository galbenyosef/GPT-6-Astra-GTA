import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import * as THREE from 'three';
import { createVehicles } from '../src/game/ai';
import type { VehicleModel } from '../src/game/types';
import { createVehicleCockpit } from '../src/render/VehicleCockpit';
import { createCabinGeometry, type Shape, type VehiclePart } from '../src/render/VehicleModels';

const geometries: Record<Shape, THREE.BufferGeometry> = {
  box: new THREE.BoxGeometry(1, 1, 1), cylinder: new THREE.CylinderGeometry(1, 1, 1, 8),
  sphere: new THREE.SphereGeometry(1, 9, 6), cone: new THREE.ConeGeometry(1, 1, 5), cabin: createCabinGeometry(),
};
const materials = new Map<string, THREE.MeshBasicMaterial>();
const part: VehiclePart = (parent, shape, color, x, y, z, sx, sy, sz, yaw = 0) => {
  if (!materials.has(color)) materials.set(color, new THREE.MeshBasicMaterial({ color }));
  const mesh = new THREE.Mesh(geometries[shape], materials.get(color));
  mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.rotation.y = yaw; parent.add(mesh);
  return mesh;
};
const fleet = createVehicles();
const make = (model: VehicleModel, police = false) => {
  const vehicle = { ...fleet.find(car => car.model === model)! };
  if (police) vehicle.kind = 'police';
  return { vehicle, node: createVehicleCockpit(vehicle, part) };
};

after(() => {
  Object.values(geometries).forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
});

for (const model of ['sedan', 'truck', 'pickup', 'hatchback', 'sport'] as const) {
  test(`${model} cockpit fits the vehicle and leaves the driver's head and forward road view clear`, () => {
    for (const police of [false, true]) {
      const { vehicle, node } = make(model, police);
      node.root.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(node.root, true);
      assert.ok(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)) <= vehicle.width / 2 + 1e-5);
      assert.ok(Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)) <= vehicle.depth / 2 + 1e-5);
      assert.ok(bounds.min.y >= 0);
      const eye = new THREE.Vector3(node.seatOffset.x, node.seatOffset.y, node.seatOffset.z);
      assert.ok(eye.x > 0, 'the driver sits on anatomical left of a +Z-facing vehicle');
      node.root.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const volume = new THREE.Box3().setFromObject(object, true).expandByScalar(.04);
        assert.ok(!volume.containsPoint(eye), `the camera must not sit inside ${object.name}`);
      });
      // The upward sample prevents a low roof from shrinking the windshield to a slit.
      for (const yaw of [-.16, 0, .16]) for (const pitch of [-.04, 0, .04, .28]) {
        const direction = new THREE.Vector3(Math.sin(yaw), Math.sin(pitch), Math.cos(yaw)).normalize();
        const hits = new THREE.Raycaster(eye, direction, .04, 20).intersectObject(node.root, true);
        assert.equal(hits.length, 0, `${model}: road sightline must not hit ${hits[0]?.object.name}`);
      }
      const camera = new THREE.PerspectiveCamera(72, 16 / 9, .04, 50);
      camera.position.copy(eye); camera.lookAt(eye.clone().add(new THREE.Vector3(0, 0, 1))); camera.updateMatrixWorld(true);
      const wheel = node.steeringWheel.getWorldPosition(new THREE.Vector3()).project(camera);
      assert.ok(Math.abs(wheel.x) < .2 && wheel.y < -.3 && wheel.y > -.95, 'the wheel center is visible below the road');
      const hood = node.root.getObjectByName('hood')!;
      const bonnet = new THREE.Box3().setFromObject(hood, true);
      assert.ok(bonnet.max.y < eye.y - .10 && bonnet.min.z > eye.z + .5, 'the visible hood stays ahead and below eye level');
    }
  });
}

test('steering rotates both hand grips around the wheel without moving the dashboard or eye position', () => {
  const { node } = make('sedan');
  node.root.updateMatrixWorld(true);
  const left = node.leftGrip.getWorldPosition(new THREE.Vector3());
  const right = node.rightGrip.getWorldPosition(new THREE.Vector3());
  const dashboard = node.root.getObjectByName('dashboard-body')!;
  const dashBefore = dashboard.getWorldPosition(new THREE.Vector3());
  const seat = { ...node.seatOffset };
  const gripSeparation = left.distanceTo(right);
  assert.ok(left.x > right.x, 'positive local X is the left hand');
  node.steeringWheel.rotation.z = 1.1;
  node.root.updateMatrixWorld(true);
  const nextLeft = node.leftGrip.getWorldPosition(new THREE.Vector3());
  const nextRight = node.rightGrip.getWorldPosition(new THREE.Vector3());
  assert.ok(nextLeft.distanceTo(left) > .15 && nextRight.distanceTo(right) > .15);
  assert.ok(Math.abs(nextLeft.distanceTo(nextRight) - gripSeparation) < 1e-8);
  assert.deepEqual(node.seatOffset, seat);
  assert.ok(dashboard.getWorldPosition(new THREE.Vector3()).distanceTo(dashBefore) < 1e-8);
});

test('side windows remain open, and the truck has a solid cargo wall behind its seat', () => {
  for (const model of ['sedan', 'truck', 'pickup', 'hatchback', 'sport'] as const) {
    const { node } = make(model);
    node.root.updateMatrixWorld(true);
    const eye = new THREE.Vector3(node.seatOffset.x, node.seatOffset.y, node.seatOffset.z);
    for (const side of [-1, 1]) {
      const hits = new THREE.Raycaster(eye, new THREE.Vector3(side, 0, 0), .04, 5).intersectObject(node.root, true);
      assert.equal(hits.length, 0, `${model} side view must pass through an open window`);
    }
    if (model === 'truck') {
      const wall = node.root.getObjectByName('cargo-bulkhead')!;
      const hits = new THREE.Raycaster(eye, new THREE.Vector3(0, 0, -1), .04, 5).intersectObject(wall, true);
      assert.ok(hits.length > 0, 'the cargo truck must not offer an impossible view through its freight box');
    }
  }
});
