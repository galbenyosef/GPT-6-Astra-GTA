import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createPedestrians } from '../src/game/ai.ts';
import { createWorld } from '../src/game/world.ts';
import { PersonModelFactory, type PersonModel } from '../src/render/PersonModels.ts';
import { personGroundHeight, poseFallenPerson, posePerson } from '../src/render/PersonAnimation.ts';

const meshes = (root: THREE.Object3D): THREE.Mesh[] => {
  const result: THREE.Mesh[] = [];
  root.traverse(object => { if (object instanceof THREE.Mesh) result.push(object); });
  return result;
};
const geometrySet = (root: THREE.Object3D) => new Set(meshes(root).map(mesh => mesh.geometry));
const materials = (root: THREE.Object3D) => new Set(meshes(root).flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
const position = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3());
const joints = (model: PersonModel) => [model.body, model.head, model.leftArm, model.rightArm, model.leftForearm, model.rightForearm,
  model.leftHand, model.rightHand, model.leftLeg, model.rightLeg, model.leftShin, model.rightShin];
const transforms = (model: PersonModel) => joints(model).map(joint => ({ position: joint.position.toArray(), rotation: joint.quaternion.toArray(), scale: joint.scale.toArray() }));
const segments = (model: PersonModel) => [
  [model.leftArm, model.leftForearm], [model.leftForearm, model.leftHand],
  [model.rightArm, model.rightForearm], [model.rightForearm, model.rightHand],
  [model.leftLeg, model.leftShin], [model.rightLeg, model.rightShin],
].map(([a, b]) => position(a).distanceTo(position(b)));

/** Inspect the surface a front-facing camera would actually see, including occlusion. */
function faceSurface(model: PersonModel, x: number, y: number) {
  model.root.updateMatrixWorld(true);
  const start = model.head.localToWorld(new THREE.Vector3(x, y, 1));
  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(model.head.getWorldQuaternion(new THREE.Quaternion()));
  const hit = new THREE.Raycaster(start, direction).intersectObject(model.head, true)[0];
  assert.ok(hit?.face, 'the face must have an outward visible surface');
  const geometry = (hit.object as THREE.Mesh).geometry;
  const colors = geometry.getAttribute('color');
  return { depth: model.head.worldToLocal(hit.point.clone()).z,
    color: new THREE.Vector3(colors.getX(hit.face.a), colors.getY(hit.face.a), colors.getZ(hit.face.a)) };
}

test('live pedestrians have stable, visibly different appearances independent of creation order', () => {
  const factory = new PersonModelFactory();
  try {
    const pedestrians = createPedestrians(createWorld());
    assert.equal(pedestrians.length, 40, 'exercise the entire live population');
    const models = pedestrians.map(person => factory.create({ id: person.id, shirt: person.color, role: 'pedestrian' }));
    assert.ok(new Set(models.map(model => model.skin)).size >= 3, 'equal-length shirt colors must not produce one identical skin tone');
    assert.ok(new Set(models.map(model => JSON.stringify(model.root.userData.appearance))).size >= 12, 'the population needs several combinations of visible facial and clothing details');
    for (const [index, person] of [...pedestrians.entries()].reverse()) {
      const again = factory.create({ id: person.id, shirt: person.color, role: 'pedestrian' });
      assert.deepEqual(again.root.userData.appearance, models[index].root.userData.appearance, 'identity survives respawn and construction order');
      assert.deepEqual([...geometrySet(again.root)], [...geometrySet(models[index].root)], 'matching appearances reuse their actual rendered buffers');
    }
    const appearances = new Map<string, PersonModel>();
    let reusedAcrossIds = false;
    for (let index = 0; index < 80; index++) {
      const model = factory.create({ id: `replacement-person-${index}`, shirt: '#7d9cae', role: 'pedestrian' });
      const key = JSON.stringify(model.root.userData.appearance), previous = appearances.get(key);
      if (previous) {
        assert.deepEqual([...geometrySet(model.root)], [...geometrySet(previous.root)], 'new identities with the same visible appearance must not allocate another set of geometry');
        reusedAcrossIds = true;
      } else appearances.set(key, model);
    }
    assert.ok(reusedAcrossIds, 'long sessions need a finite pool of reusable appearances');
  } finally { factory.dispose(); }
});

test('every human role has finite outward geometry and human-sized bounds above the ground', () => {
  const factory = new PersonModelFactory();
  try {
    const models = [
      factory.create({ id: 'player', shirt: '#f4ebd7', role: 'player' }),
      ...Array.from({ length: 40 }, (_, index) => factory.create({ id: `ped-${index}`, shirt: '#7d9cae', role: 'pedestrian' })),
      ...Array.from({ length: 6 }, (_, index) => factory.create({ id: `officer-police-${index}`, shirt: '#2f4b63', role: 'officer' })),
    ];
    const checked = new Set<THREE.BufferGeometry>();
    for (const model of models) {
      const bounds = new THREE.Box3().setFromObject(model.root, true);
      const size = bounds.getSize(new THREE.Vector3());
      assert.ok(bounds.min.y >= -.025, 'resting feet must not sink through the pavement');
      assert.ok(size.y > 2 && size.y < 2.5, 'clothing and hats must retain the authored human scale');
      assert.ok(size.x > .6 && size.x < 1.25 && size.z > .3 && size.z < 1, 'fine details cannot make a person oversized');
      for (const mesh of meshes(model.root)) {
        assert.ok(mesh.castShadow, 'the detailed body must retain a coherent silhouette in sunlight');
        const geometry = mesh.geometry;
        if (checked.has(geometry)) continue;
        checked.add(geometry);
        const points = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'), colors = geometry.getAttribute('color');
        assert.ok(points && normals && colors, 'merged body details require positions, lighting normals, and appearance colors');
        assert.equal(normals.count, points.count);
        assert.equal(colors.count, points.count);
        for (let vertex = 0; vertex < points.count; vertex++) {
          const point = new THREE.Vector3().fromBufferAttribute(points, vertex);
          const normal = new THREE.Vector3().fromBufferAttribute(normals, vertex);
          assert.ok([...point.toArray(), ...normal.toArray(), colors.getX(vertex), colors.getY(vertex), colors.getZ(vertex)].every(Number.isFinite));
          assert.ok(normal.lengthSq() > .95 && normal.lengthSq() < 1.05, 'malformed normals must not produce black facial or clothing patches');
        }
      }
    }
  } finally { factory.dispose(); }
});

test('eyes, pupils, nose, and mouth remain visible in front of the head surface', () => {
  const factory = new PersonModelFactory();
  try {
    const candidates = Array.from({ length: 40 }, (_, index) => factory.create({ id: `ped-${index}`, shirt: '#7d9cae', role: 'pedestrian' }));
    const bySkin = new Map(candidates.map(model => [model.skin, model]));
    const models = [factory.create({ id: 'player', shirt: '#f4ebd7', role: 'player' }),
      ...bySkin.values(), factory.create({ id: 'officer-police-0', shirt: '#2f4b63', role: 'officer' })];
    for (const model of models) {
      for (const side of [-1, 1]) {
        const visibleEye = [.053, .065, .078, .09, .105, .12].flatMap(x => [.03, .043, .055].map(y => faceSurface(model, side * x, y)));
        assert.ok(visibleEye.some(surface => Math.min(...surface.color.toArray()) > .6), 'each visible eye needs a white rather than a buried decorative shape');
        assert.ok(visibleEye.some(surface => Math.max(...surface.color.toArray()) < .1), 'each visible eye needs a contrasted pupil');
      }
      const nose = faceSurface(model, 0, -.04);
      const cheek = faceSurface(model, .14, -.04);
      assert.ok(nose.depth > cheek.depth + .07, 'the nose needs visible facial depth');
      const mouth = faceSurface(model, 0, -.116);
      const skin = new THREE.Color(model.skin);
      assert.ok(mouth.color.distanceTo(new THREE.Vector3(skin.r, skin.g, skin.b)) > .025, 'the mouth must remain a visible detail across skin tones');
    }
  } finally { factory.dispose(); }
});

test('standing soles follow actual road, pavement, curb, courtyard, and waterfront heights', () => {
  const world = createWorld();
  const half = world.size / 2;
  // These are the tops of the real boxes authored by GameRenderer.buildGround.
  const surfaces = [
    { name: 'vertical road', x: 0, z: 40, top: .075 },
    { name: 'intersection', x: 0, z: 0, top: .077 },
    { name: 'sidewalk', x: 11.3, z: 40, top: .23 },
    { name: 'opposite sidewalk', x: -11.3, z: -40, top: .23 },
    { name: 'curb', x: 9.13, z: 40, top: .27 },
    { name: 'open courtyard', x: 24, z: 40, top: .025 },
    { name: 'east promenade', x: half - 3, z: 40, top: .20 },
    { name: 'north promenade', x: 40, z: half - 3, top: .21 },
    { name: 'road meeting promenade', x: 0, z: half - 3, top: .21 },
    { name: 'waterfront corner', x: half - 3, z: half - 3, top: .21 },
    { name: 'curb meeting promenade', x: 9.13, z: half - 2, top: .27 },
    { name: 'beyond sidewalk end', x: 11.3, z: half - .5, top: .21 },
  ];
  const factory = new PersonModelFactory();
  try {
    const person = factory.create({ id: 'player', shirt: '#f4ebd7', role: 'player' });
    for (const surface of surfaces) {
      person.root.position.set(surface.x, personGroundHeight(world, surface.x, surface.z), surface.z);
      const bounds = new THREE.Box3().setFromObject(person.root, true);
      assert.ok(bounds.min.y >= surface.top - .002, `${surface.name}: shoes sink into the authored surface`);
      assert.ok(bounds.min.y <= surface.top + .04, `${surface.name}: shoes float above the authored surface`);
      assert.equal(person.root.position.x, surface.x);
      assert.equal(person.root.position.z, surface.z);
    }
  } finally { factory.dispose(); }
});

test('walking and running keep articulated hands and knees attached across a complete stride', () => {
  const factory = new PersonModelFactory();
  try {
    const model = factory.create({ id: 'player', shirt: '#f4ebd7', role: 'player' });
    const lengths = segments(model);
    const firstHand = position(model.rightHand), firstKnee = position(model.rightShin);
    let handTravel = 0, kneeTravel = 0, elbowBent = false, kneeBent = false;
    for (const running of [false, true]) for (let frame = 0; frame < 64; frame++) {
      posePerson(model, frame / 64 * Math.PI * 2, true, running);
      model.root.updateMatrixWorld(true);
      segments(model).forEach((length, index) => assert.ok(Math.abs(length - lengths[index]) < 1e-6, 'a joint must not separate its connected limb while animated'));
      handTravel = Math.max(handTravel, position(model.rightHand).distanceTo(firstHand));
      kneeTravel = Math.max(kneeTravel, position(model.rightShin).distanceTo(firstKnee));
      elbowBent ||= Math.abs(model.rightForearm.rotation.x) > .25;
      kneeBent ||= Math.abs(model.rightShin.rotation.x) > .3;
      const bounds = new THREE.Box3().setFromObject(model.root, true);
      assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite));
      assert.ok(bounds.min.y >= -.001 && bounds.max.y < 2.7, 'a complete stride must keep the actual rendered soles above the ground');
    }
    assert.ok(handTravel > .3 && kneeTravel > .15, 'the new joints must animate visible limbs');
    assert.ok(elbowBent && kneeBent, 'running must articulate both elbows and knees');
  } finally { factory.dispose(); }
});

test('falling resets a running pose and returning to idle leaves no bent or displaced joints', () => {
  const factory = new PersonModelFactory();
  try {
    const model = factory.create({ id: 'player', shirt: '#f4ebd7', role: 'player' });
    const clean = factory.create({ id: 'player', shirt: '#f4ebd7', role: 'player' });
    posePerson(model, 1.2, true, true);
    for (const amount of [0, .15, .5, 1]) {
      poseFallenPerson(model, amount);
      poseFallenPerson(clean, amount);
      assert.deepEqual(transforms(model), transforms(clean), 'the fall must not depend on the preceding gait');
      const bounds = new THREE.Box3().setFromObject(model.root, true);
      assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite));
    }
    posePerson(model, 0, false);
    posePerson(clean, 0, false);
    assert.deepEqual(transforms(model), transforms(clean));
    const bounds = new THREE.Box3().setFromObject(model.root, true);
    assert.ok(bounds.max.y > 2 && bounds.min.y > -.04, 'the revived character must stand upright again');
  } finally { factory.dispose(); }
});

test('shared appearance buffers retain independent poses and dispose exactly once', () => {
  const factory = new PersonModelFactory();
  const first = factory.create({ id: 'ped-7', shirt: '#9bbb99', role: 'pedestrian' });
  const second = factory.create({ id: 'ped-7', shirt: '#9bbb99', role: 'pedestrian' });
  const officer = factory.create({ id: 'officer-police-0', shirt: '#2f4b63', role: 'officer' });
  const hand = factory.createHand(first.skin, 'right', true);
  assert.notEqual(first.root, second.root);
  assert.notEqual(first.leftForearm, second.leftForearm);
  assert.deepEqual([...geometrySet(first.root)], [...geometrySet(second.root)]);
  const resting = transforms(second);
  posePerson(first, 1.4, true, true);
  assert.deepEqual(transforms(second), resting, 'animating one cached appearance cannot move another person');
  const allMaterials = new Set([first.root, second.root, officer.root, hand].flatMap(root => [...materials(root)]));
  assert.ok(allMaterials.size <= 3, 'facial and clothing colors should be batched instead of adding a material per detail');
  const resources = new Set<THREE.BufferGeometry | THREE.Material>([...allMaterials,
    ...[first.root, second.root, officer.root, hand].flatMap(root => [...geometrySet(root)])]);
  const counts = new Map([...resources].map(resource => [resource, 0]));
  for (const resource of resources) resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource)! + 1));
  factory.dispose(); factory.dispose();
  for (const count of counts.values()) assert.equal(count, 1, 'shared rendered resources must be released once when the owning renderer closes');
});
