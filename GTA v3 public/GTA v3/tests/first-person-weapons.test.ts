import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Simulation } from '../src/game/simulation';
import type { FirearmId, GameState, WeaponId } from '../src/game/types';
import { FirstPersonWeapons } from '../src/render/FirstPersonWeapons';
import { PersonModelFactory } from '../src/render/PersonModels';
import { createCabinGeometry, type Shape, type VehiclePart } from '../src/render/VehicleModels';
import { createWeaponModel } from '../src/render/WeaponModels';

const SKIN = '#c99773', SHIRT = '#eee4cb';
const ids: WeaponId[] = ['knife', 'pistol', 'rifle'];
const meshes = (root: THREE.Object3D, visible = false): THREE.Mesh[] => {
  const result: THREE.Mesh[] = [];
  const visit = (object: THREE.Object3D) => { if (object instanceof THREE.Mesh) result.push(object); };
  if (visible) root.traverseVisible(visit); else root.traverse(visit);
  return result;
};
const worldPosition = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3());

/** The same shared primitive/material contract as the renderer, with real vertices. */
function fixture() {
  const shapes: Record<Shape, THREE.BufferGeometry> = {
    box: new THREE.BoxGeometry(1, 1, 1), cylinder: new THREE.CylinderGeometry(1, 1, 1, 8),
    sphere: new THREE.SphereGeometry(1, 9, 6), cone: new THREE.ConeGeometry(1, 1, 5), cabin: createCabinGeometry(),
  };
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const part: VehiclePart = (parent, shape, color, x, y, z, sx, sy, sz, yaw = 0, shadow = true) => {
    let material = materials.get(color);
    if (!material) { material = new THREE.MeshStandardMaterial({ color }); materials.set(color, material); }
    const mesh = new THREE.Mesh(shapes[shape], material);
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.rotation.y = yaw;
    mesh.castShadow = shadow; mesh.receiveShadow = true; parent.add(mesh);
    return mesh;
  };
  const factory = new PersonModelFactory();
  const flashMaterial = new THREE.MeshBasicMaterial({ color: '#ffdc6b' });
  const scene = new THREE.Scene();
  const createView = () => {
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, .035, 740);
    camera.position.set(12, 2.15, -25); scene.add(camera);
    const model = new FirstPersonWeapons(part, factory, SKIN, SHIRT, flashMaterial);
    model.root.visible = true; camera.add(model.root);
    return { camera, model };
  };
  const view = createView();
  const state = new Simulation().state;
  state.time = 10; state.player.moving = false; state.combat.lastAttackAt = -10;
  return { ...view, state, scene, shapes, materials, factory, flashMaterial, part, createView,
    dispose() {
      scene.clear(); factory.dispose();
      Object.values(shapes).forEach(shape => shape.dispose());
      materials.forEach(material => material.dispose()); flashMaterial.dispose();
    },
  };
}

function pose(view: { camera: THREE.PerspectiveCamera; model: FirstPersonWeapons }, state: GameState, dt = 1, wall = Infinity) {
  view.camera.fov = state.combat.aiming && state.combat.weapon !== 'knife' ? 58 : 75;
  view.camera.updateProjectionMatrix();
  view.model.update(state, dt, wall); view.camera.updateMatrixWorld(true);
}

function recordAttack(state: GameState, weapon: WeaponId, age: number) {
  const time = state.time - age;
  state.combat.lastAttackAt = time;
  state.combat.shots = [{ id: state.combat.nextShotId++, owner: 'player', weapon, time, hit: false,
    from: { x: state.player.x, y: 1.72, z: state.player.z },
    to: { x: state.player.x, y: 1.72, z: state.player.z + 10 } }];
}

/** Count actual drawable vertices inside the current camera frustum. */
function projectedCoverage(root: THREE.Object3D, camera: THREE.Camera) {
  let inView = 0, total = 0;
  for (const mesh of meshes(root, true)) {
    const vertices = mesh.geometry.getAttribute('position');
    for (let i = 0; i < vertices.count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(mesh.matrixWorld).project(camera);
      assert.ok(point.toArray().every(Number.isFinite));
      if (Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && point.z >= -1 && point.z <= 1) inView++;
      total++;
    }
  }
  return { inView, total };
}

test('every held weapon and its gripping hand has real visible geometry while looking up, down, and sideways', () => {
  const f = fixture();
  try {
    for (const id of ids) for (const pitch of [-1.35, 0, 1.35]) {
      f.state.combat.weapon = id; f.state.combat.aiming = false;
      f.camera.rotation.set(-pitch, 2.4, 0, 'YXZ'); pose(f, f.state);
      assert.deepEqual([...f.model.weapons].filter(([, value]) => value.root.visible).map(([key]) => key), [id]);
      const weapon = f.model.weapons.get(id)!;
      const coverage = projectedCoverage(weapon.root, f.camera);
      assert.ok(coverage.total > 100, `${id} must contain real weapon surfaces`);
      assert.ok(coverage.inView / coverage.total > .35, `${id} should remain visibly held at extreme world pitch`);
      const hand = f.model.grip.getObjectByName('right-gripping-hand')!;
      assert.ok(hand, 'the held weapon needs an actual detailed gripping hand');
      const handCoverage = projectedCoverage(hand, f.camera);
      assert.ok(handCoverage.inView > 40, `${id} gripping fingers should be visible in the frame`);
      assert.ok(meshes(f.model.root).every(mesh => !mesh.castShadow), 'eye-space hands must not cast a detached player shadow');
    }
  } finally { f.dispose(); }
});

test('ADS leaves the center ray clear and places the real front and rear sights near the crosshair', () => {
  const f = fixture();
  try {
    for (const id of ['pistol', 'rifle'] as const) {
      f.state.combat.weapon = id; f.state.combat.aiming = true; pose(f, f.state);
      const ray = new THREE.Raycaster(worldPosition(f.camera), f.camera.getWorldDirection(new THREE.Vector3()), f.camera.near, 4);
      assert.equal(ray.intersectObjects(meshes(f.model.root, true), false).length, 0,
        `${id}: an opaque rear sight, hand, or receiver must not cover the crosshair`);
      const weapon = f.model.weapons.get(id)!;
      const sights = meshes(weapon.root).filter(mesh => mesh.geometry === f.shapes.box && mesh.position.y > .18 &&
        mesh.scale.x < .09 && mesh.scale.y < .15 && mesh.scale.z < .1);
      assert.ok(sights.length >= 2, `${id} needs actual front and rear sight geometry`);
      const frontZ = Math.max(...sights.map(mesh => mesh.position.z));
      const rearZ = Math.min(...sights.map(mesh => mesh.position.z));
      const averageTop = (at: number) => {
        const points = sights.filter(mesh => Math.abs(mesh.position.z - at) < .001)
          .map(mesh => mesh.localToWorld(new THREE.Vector3(0, .5, 0)).project(f.camera));
        return points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(points.length);
      };
      const front = averageTop(frontZ), rear = averageTop(rearZ);
      assert.ok(Math.abs(front.x) < .035 && Math.abs(rear.x) < .06, `${id} sights must be horizontally centered`);
      assert.ok(front.y > -.13 && front.y < .015, `${id} front sight should sit just below the clear crosshair`);
      assert.ok(rear.y > -.18 && rear.y < .15, `${id} rear sight should remain close to the same line of sight`);
    }
  } finally { f.dispose(); }
});

test('hand grips and forearm joints remain connected throughout attacks, reloads, wall lowering, and mouse pitch', () => {
  const f = fixture();
  try {
    const segments = meshes(f.model.root).filter(mesh => mesh.parent === f.model.root && mesh.geometry === f.shapes.cylinder);
    const sleeves = segments.filter(mesh => (mesh.material as THREE.MeshStandardMaterial).color.getHexString() === SHIRT.slice(1));
    const forearms = segments.filter(mesh => (mesh.material as THREE.MeshStandardMaterial).color.getHexString() === SKIN.slice(1));
    assert.equal(sleeves.length, 2); assert.equal(forearms.length, 2);
    for (const id of ids) for (const progress of [0, .2, .5, .8, .99]) for (const pitch of [-1.2, 0, 1.2]) {
      f.state.combat.weapon = id;
      recordAttack(f.state, id, progress * .32);
      f.state.combat.reload = id === 'knife' ? null : { weapon: id as FirearmId, duration: 2, remaining: 2 * (1 - progress) };
      f.state.combat.aiming = progress > .4; f.state.player.moving = progress > .1;
      f.camera.rotation.set(-pitch, -2.8, 0, 'YXZ'); pose(f, f.state, .1, progress > .7 ? .2 : Infinity);
      const rightHand = f.model.grip.getObjectByName('right-gripping-hand')!;
      const leftHand = f.model.root.getObjectByName(id === 'knife' ? 'left-hand' : 'left-gripping-hand')!;
      assert.ok(rightHand.visible && leftHand.visible);
      assert.ok(worldPosition(rightHand).distanceTo(worldPosition(f.model.weapons.get(id)!.root)) < 1e-9,
        'the actual palm origin must remain attached to the weapon grip during animation');
      const hands = [worldPosition(rightHand), worldPosition(leftHand)];
      const elbowEnds = sleeves.map(mesh => mesh.localToWorld(new THREE.Vector3(0, .5, 0)));
      for (const forearm of forearms) {
        const elbow = forearm.localToWorld(new THREE.Vector3(0, -.5, 0));
        const wrist = forearm.localToWorld(new THREE.Vector3(0, .5, 0));
        assert.ok(elbowEnds.some(point => point.distanceTo(elbow) < 1e-9), 'upper arm and forearm surfaces must share their elbow');
        assert.ok(hands.some(point => point.distanceTo(wrist) < 1e-9), 'the forearm must reach its rendered hand');
      }
      const handBounds = new THREE.Box3().setFromObject(rightHand, true);
      assert.ok(meshes(f.model.weapons.get(id)!.root, true).some(mesh => handBounds.intersectsBox(new THREE.Box3().setFromObject(mesh, true))),
        `${id} needs physical hand/handle contact rather than only coincident empty groups`);
      for (const mesh of meshes(f.model.root, true)) assert.ok(mesh.matrixWorld.elements.every(Number.isFinite));
    }
  } finally { f.dispose(); }
});

test('extreme attacks and reloads keep held geometry beyond the near plane without filling the view', () => {
  const f = fixture();
  try {
    const hands = ['right-gripping-hand', 'left-gripping-hand', 'left-hand']
      .map(name => f.model.root.getObjectByName(name)!);
    for (const id of ids) for (const aiming of [false, true]) for (const progress of [0, .1, .25, .5, .75, .99]) for (const wall of [Infinity, .2]) {
      f.state.combat.weapon = id; f.state.combat.aiming = aiming;
      recordAttack(f.state, id, progress * .32);
      f.state.combat.reload = id === 'knife' ? null : { weapon: id, duration: 2, remaining: 2 * (1 - progress) };
      f.state.player.moving = true;
      f.camera.rotation.set(-1.15, 2.6, 0, 'YXZ'); pose(f, f.state, 1, wall);
      const held = f.model.weapons.get(id)!.root;
      const heldMeshes = [...meshes(held, true), ...hands.filter(hand => hand.visible).flatMap(hand => meshes(hand, true))];
      for (const mesh of heldMeshes) {
        const vertices = mesh.geometry.getAttribute('position');
        for (let i = 0; i < vertices.count; i++) {
          const point = new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(f.camera.matrixWorldInverse);
          assert.ok(point.z < -f.camera.near - .005, `${id}: hands and the weapon must not cross the eye's near clipping plane`);
        }
      }
      if (wall !== Infinity) continue; // Intentional wall lowering can move the weapon out of the bottom of the frame.
      const projected = new THREE.Box2();
      for (const mesh of meshes(held, true)) {
        const vertices = mesh.geometry.getAttribute('position');
        for (let i = 0; i < vertices.count; i++) {
          const point = new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(mesh.matrixWorld).project(f.camera);
          projected.expandByPoint(new THREE.Vector2(point.x, point.y));
        }
      }
      // A magazine may travel below the frame during reload; only its visible
      // footprint can obstruct the player's view of the world.
      const size = projected.intersect(new THREE.Box2(new THREE.Vector2(-1, -1), new THREE.Vector2(1, 1))).getSize(new THREE.Vector2());
      assert.ok(size.x < 1.3 && size.y < 1.8, `${id} should retain a usable view of the world during its largest animation`);
      const coverage = projectedCoverage(held, f.camera);
      assert.ok(coverage.inView > 25, `${id} animation should retain visible weapon surfaces`);
    }
  } finally { f.dispose(); }
});

test('weapon muzzle origins match the resting barrel or blade and stay forward within the eye validation range', () => {
  const f = fixture();
  try {
    for (const id of ids) for (const aiming of [false, true]) for (const pitch of [-1.35, 0, 1.35]) {
      f.state.combat.weapon = id; f.state.combat.aiming = aiming; f.state.combat.reload = null;
      f.state.combat.lastAttackAt = -10; f.state.player.moving = false;
      f.camera.rotation.set(-pitch, -2.7, 0, 'YXZ'); pose(f, f.state);
      const muzzle = f.model.getMuzzle(id).clone();
      const weapon = f.model.weapons.get(id)!;
      const renderedTip = weapon.root.localToWorld(weapon.muzzle.clone());
      assert.ok(muzzle.distanceTo(renderedTip) < 1e-7, `${id}: resting firing origin should coincide with the actual barrel tip`);
      const relative = muzzle.clone().sub(worldPosition(f.camera));
      assert.ok(muzzle.toArray().every(Number.isFinite));
      assert.ok(relative.length() > .3 && relative.length() < 1.6, `${id} muzzle must fit combat's eye-origin validation`);
      assert.ok(relative.dot(f.camera.getWorldDirection(new THREE.Vector3())) > .3, `${id} muzzle must stay in front of the eye at extreme pitch`);
      assert.ok(relative.normalize().dot(f.camera.getWorldDirection(new THREE.Vector3())) > .75);
    }
  } finally { f.dispose(); }
});

test('decorative recoil, reloads, walking, and obstruction do not move the authoritative firing origin', () => {
  const f = fixture();
  try {
    for (const id of ['pistol', 'rifle'] as const) {
      f.state.combat.weapon = id; f.state.combat.aiming = false; f.state.combat.reload = null;
      f.state.combat.lastAttackAt = -10; f.state.player.moving = false; pose(f, f.state);
      const baseline = f.model.getMuzzle(id).clone(), restGrip = worldPosition(f.model.grip);
      for (const age of [0, .04, .12, .25]) {
        recordAttack(f.state, id, age);
        f.state.combat.reload = { weapon: id, duration: 2, remaining: .9 };
        f.state.player.moving = true; pose(f, f.state, 1 / 60, .2);
        assert.ok(f.model.getMuzzle(id).clone().distanceTo(baseline) < 1e-8);
        assert.ok(worldPosition(f.model.grip).distanceTo(restGrip) > .1, 'exercise actual decorative lowering rather than an unchanged pose');
      }
    }
  } finally { f.dispose(); }
});

test('independent viewmodels preserve cached geometry, other poses, and renderer-owned resource lifetime', () => {
  const f = fixture();
  const disposed = new Map<THREE.BufferGeometry | THREE.Material, number>();
  try {
    const other = f.createView(); other.camera.position.x += 50;
    f.state.combat.weapon = 'rifle'; pose(other, f.state);
    const thirdPerson = createWeaponModel('rifle', f.part); f.scene.add(thirdPerson.root);
    const resources = new Set<THREE.BufferGeometry | THREE.Material>();
    for (const mesh of meshes(f.scene)) {
      resources.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) resources.add(material);
    }
    resources.forEach(resource => { disposed.set(resource, 0); resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource)! + 1)); });
    const buffers = new Map([...resources].filter((item): item is THREE.BufferGeometry => item instanceof THREE.BufferGeometry)
      .map(geometry => [geometry, Array.from(geometry.getAttribute('position').array)]));
    const poseSnapshot = () => {
      const result: number[][] = [];
      other.model.root.traverse(object => result.push([...object.position.toArray(), ...object.quaternion.toArray(), ...object.scale.toArray(), Number(object.visible)]));
      return result;
    };
    const before = poseSnapshot(), thirdScale = thirdPerson.root.scale.clone();
    for (let frame = 0; frame < 90; frame++) {
      f.state.combat.weapon = ids[frame % ids.length]; f.state.combat.aiming = frame % 2 === 0;
      recordAttack(f.state, f.state.combat.weapon, .1); f.state.player.moving = true;
      pose(f, f.state, 1 / 60, frame % 4 ? Infinity : .2);
    }
    assert.deepEqual(poseSnapshot(), before, 'shared geometry cannot couple the pose or visibility of another actor');
    assert.ok(thirdPerson.root.scale.distanceTo(thirdScale) < 1e-12, 'FPS scaling must not resize cached third-person weapons');
    for (const [geometry, contents] of buffers) assert.deepEqual(Array.from(geometry.getAttribute('position').array), contents);
    for (const mesh of meshes(f.model.root)) {
      assert.ok(resources.has(mesh.geometry), 'pose updates must reuse their existing GPU geometry');
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) assert.ok(resources.has(material));
    }
    f.model.root.removeFromParent(); other.model.root.removeFromParent(); thirdPerson.root.removeFromParent();
    assert.ok([...disposed.values()].every(count => count === 0), 'removing a viewmodel must not dispose renderer/factory-owned shared resources');
  } finally { f.dispose(); }
  assert.ok([...disposed.values()].every(count => count === 1), 'the owning renderer/factory can release every shared resource exactly once');
});

test('switching weapons cannot reuse another weapon attack, while a real knife swing outlives its short tracer', () => {
  const f = fixture();
  try {
    f.state.combat.weapon = 'knife'; pose(f, f.state);
    const knifeRest = f.model.grip.position.clone(), knifeOrientation = f.model.grip.quaternion.clone();
    f.state.combat.weapon = 'pistol'; pose(f, f.state);
    const pistolRest = f.model.grip.position.clone(), pistolOrientation = f.model.grip.quaternion.clone();

    f.state.combat.weapon = 'knife'; recordAttack(f.state, 'knife', .04); pose(f, f.state, 0);
    assert.ok(f.model.grip.position.distanceTo(knifeRest) > .05, 'the fixture must first produce an actual knife attack');
    f.state.time += .01; f.state.combat.weapon = 'pistol'; pose(f, f.state, 0);
    assert.equal(f.model.weapons.get('pistol')!.flash!.visible, false, 'a knife attack cannot flash the newly equipped pistol');
    assert.ok(f.model.grip.position.distanceTo(pistolRest) < 1e-10, 'a knife attack cannot produce pistol recoil');
    assert.ok(f.model.grip.quaternion.angleTo(pistolOrientation) < 1e-7);

    recordAttack(f.state, 'pistol', .01); pose(f, f.state, 0);
    assert.equal(f.model.weapons.get('pistol')!.flash!.visible, true, 'a real shot still shows its own muzzle flash');
    assert.ok(f.model.grip.position.distanceTo(pistolRest) > .02, 'a real shot still produces recoil');
    f.state.time += .04; f.state.combat.weapon = 'knife'; pose(f, f.state, 0);
    assert.ok(f.model.grip.position.distanceTo(knifeRest) < 1e-10, 'a pistol shot cannot trigger a newly equipped knife slash');
    assert.ok(f.model.grip.quaternion.angleTo(knifeOrientation) < 1e-7);
    assert.ok([...f.model.weapons.values()].every(weapon => !weapon.flash?.visible));

    f.state.time += 1; recordAttack(f.state, 'knife', 0); pose(f, f.state, 0);
    f.state.time += .24; f.state.combat.shots = []; pose(f, f.state, 0);
    assert.ok(f.model.grip.position.distanceTo(knifeRest) > .1, 'the slash must continue after combat removes its short-lived tracer');
    f.state.time += .09; pose(f, f.state, 0);
    assert.ok(f.model.grip.position.distanceTo(knifeRest) < 1e-10, 'the remembered attack must finish after its animation duration');
  } finally { f.dispose(); }
});
