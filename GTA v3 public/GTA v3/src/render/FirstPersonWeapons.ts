import * as THREE from 'three';
import type { GameState, WeaponId } from '../game/types';
import type { VehiclePart } from './VehicleModels';
import { createWeaponModel, type WeaponNode } from './WeaponModels';
import type { PersonModelFactory } from './PersonModels';

const SCALE: Record<WeaponId, number> = { knife: .67, pistol: .74, rifle: .58 };

/** A camera-local grip. +X is screen right, -Z points through the crosshair. */
export function firstPersonGrip(weapon: WeaponId, aiming: number, position: THREE.Vector3): THREE.Vector3 {
  const blend = weapon === 'knife' ? 0 : THREE.MathUtils.clamp(aiming, 0, 1);
  const sightHeight = (weapon === 'rifle' ? .29 * SCALE.rifle : .212 * SCALE.pistol) + .008;
  return position.set(
    THREE.MathUtils.lerp(weapon === 'knife' ? .28 : .24, 0, blend),
    THREE.MathUtils.lerp(weapon === 'knife' ? -.29 : -.30, -sightHeight, blend),
    THREE.MathUtils.lerp(weapon === 'rifle' ? -.56 : -.57, weapon === 'rifle' ? -.50 : -.56, blend),
  );
}

/** Detailed hands and weapon models in eye space, rendered with ordinary world occlusion. */
export class FirstPersonWeapons {
  readonly root = new THREE.Group();
  readonly grip = new THREE.Group();
  readonly weapons = new Map<WeaponId, WeaponNode>();
  private readonly rightHand: THREE.Group;
  private readonly leftHand: THREE.Group;
  private readonly leftOpenHand: THREE.Group;
  private readonly rightSleeve: THREE.Mesh;
  private readonly leftSleeve: THREE.Mesh;
  private readonly rightForearm: THREE.Mesh;
  private readonly leftForearm: THREE.Mesh;
  private readonly rightShoulder = new THREE.Vector3(.31, -.5, .04);
  private readonly leftShoulder = new THREE.Vector3(-.31, -.5, .04);
  private readonly rightElbow = new THREE.Vector3(.34, -.43, -.18);
  private readonly leftElbow = new THREE.Vector3(-.28, -.42, -.24);
  private readonly rightGoal = new THREE.Vector3();
  private readonly leftGoal = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly muzzle = new THREE.Vector3();
  private readonly neutral = new THREE.Vector3();
  private aimingBlend = 0;
  private obstruction = 0;
  private lastAttack: { weapon: WeaponId; time: number } | null = null;

  constructor(part: VehiclePart, factory: PersonModelFactory, skin: string, shirt: string, flashMaterial: THREE.Material) {
    this.root.name = 'first-person-weapons';
    this.grip.name = 'first-person-grip';
    this.root.add(this.grip);
    for (const id of ['knife', 'pistol', 'rifle'] as const) {
      const weapon = createWeaponModel(id, part, 'first');
      weapon.root.scale.set(SCALE[id] * .8, SCALE[id], SCALE[id]);
      if (id === 'knife') weapon.root.rotation.x = -Math.PI / 2;
      if (weapon.flash) weapon.flash.material = flashMaterial;
      this.grip.add(weapon.root);
      this.weapons.set(id, weapon);
    }
    this.rightHand = factory.createHand(skin, 'right', true);
    this.rightHand.scale.setScalar(.85);
    this.grip.add(this.rightHand);
    this.leftHand = factory.createHand(skin, 'left', true);
    this.leftOpenHand = factory.createHand(skin, 'left');
    this.leftHand.scale.setScalar(.85); this.leftOpenHand.scale.setScalar(.85);
    this.root.add(this.leftHand, this.leftOpenHand);
    const sleeve = () => part(this.root, 'cylinder', shirt, 0, 0, 0, .073, 1, .078, 0, false);
    const forearm = () => part(this.root, 'cylinder', skin, 0, 0, 0, .055, 1, .063, 0, false);
    this.rightSleeve = sleeve(); this.leftSleeve = sleeve();
    this.rightForearm = forearm(); this.leftForearm = forearm();
    this.root.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = false; object.receiveShadow = false; } });
    this.root.visible = false;
  }

  private segment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3) {
    this.direction.copy(to).sub(from);
    mesh.position.copy(from).add(to).multiplyScalar(.5);
    mesh.scale.y = this.direction.length();
    mesh.quaternion.setFromUnitVectors(this.up, this.direction.normalize());
  }

  update(state: GameState, dt: number, distanceToWall: number) {
    const { combat } = state, id = combat.weapon;
    const follow = 1 - Math.exp(-Math.max(0, dt) * 18);
    this.aimingBlend += ((combat.aiming && id !== 'knife' ? 1 : 0) - this.aimingBlend) * follow;
    const blocked = THREE.MathUtils.clamp((1.05 - distanceToWall) / .6, 0, 1);
    this.obstruction = blocked > this.obstruction ? blocked : THREE.MathUtils.lerp(this.obstruction, blocked, follow);
    for (let index = combat.shots.length - 1; index >= 0; index--) {
      const shot = combat.shots[index];
      if (shot.owner === 'player') { this.lastAttack = shot; break; }
    }
    const age = this.lastAttack?.weapon === id && this.lastAttack.time === combat.lastAttackAt
      ? state.time - this.lastAttack.time : Infinity;
    const recoil = id !== 'knife' && age >= 0 && age < .2 ? Math.exp(-age * 28) * .055 : 0;
    const reload = combat.reload ? 1 - combat.reload.remaining / combat.reload.duration : 0;
    const reloadArc = combat.reload ? Math.sin(reload * Math.PI) : 0;
    const swing = id === 'knife' && age >= 0 && age < .32 ? Math.sin(age / .32 * Math.PI) : 0;
    const bob = state.player.moving ? Math.sin(state.time * 10.5) * .007 * (1 - this.aimingBlend * .8) : 0;
    firstPersonGrip(id, this.aimingBlend, this.grip.position);
    this.grip.position.x += Math.sin(state.time * 5.25) * Math.abs(bob) - swing * .27 - reloadArc * .11;
    this.grip.position.y += bob - reloadArc * .16 - this.obstruction * .2;
    this.grip.position.z += recoil + this.obstruction * .13 - swing * .15;
    this.grip.rotation.set(recoil * 1.3 + swing * 1.05 + reloadArc * .45 + this.obstruction * .45, Math.PI, -.13 * swing + reloadArc * .32, 'YXZ');
    this.grip.updateMatrix();
    for (const [key, model] of this.weapons) {
      model.root.visible = key === id;
      if (model.flash) model.flash.visible = key === id && age >= 0 && age < .065 && !combat.reload;
      if (model.magazine) model.magazine.position.y = model.magazineY - (key === id ? reloadArc * .24 : 0);
    }
    this.rightGoal.copy(this.grip.position);
    this.leftHand.visible = id !== 'knife';
    this.leftOpenHand.visible = id === 'knife';
    if (id === 'knife') {
      this.leftGoal.set(-.24, -.42 - this.obstruction * .1, -.4);
      this.leftOpenHand.position.copy(this.leftGoal);
      this.leftOpenHand.rotation.set(-.4, Math.PI, -.12);
    } else {
      this.leftGoal.set(id === 'rifle' ? .02 : .057, reloadArc > 0 ? -.19 - reloadArc * .12 : -.025,
        id === 'rifle' ? reloadArc > 0 ? .16 : .4 : -.015).multiplyScalar(SCALE[id]).applyMatrix4(this.grip.matrix);
      this.leftHand.position.copy(this.leftGoal);
      this.leftHand.quaternion.copy(this.grip.quaternion);
    }
    this.rightElbow.set(.34, -.43 - this.obstruction * .07, -.18);
    this.leftElbow.copy(this.leftShoulder).lerp(this.leftGoal, .5);
    this.leftElbow.y -= .065;
    this.segment(this.rightSleeve, this.rightShoulder, this.rightElbow);
    this.segment(this.rightForearm, this.rightElbow, this.rightGoal);
    this.segment(this.leftSleeve, this.leftShoulder, this.leftElbow);
    this.segment(this.leftForearm, this.leftElbow, this.leftGoal);
  }

  /** Stable firing position, excluding decorative recoil, reload and walking motion. */
  getMuzzle(weapon: WeaponId): THREE.Vector3 {
    const model = this.weapons.get(weapon)!;
    firstPersonGrip(weapon, this.aimingBlend, this.neutral);
    model.root.updateMatrix();
    this.muzzle.copy(model.muzzle).applyMatrix4(model.root.matrix);
    this.muzzle.x *= -1; this.muzzle.z *= -1;
    this.muzzle.add(this.neutral);
    this.root.updateWorldMatrix(true, false);
    return this.root.localToWorld(this.muzzle);
  }
}
