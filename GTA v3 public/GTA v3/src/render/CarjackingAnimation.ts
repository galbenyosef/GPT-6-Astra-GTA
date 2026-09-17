import * as THREE from 'three';
import type { CarjackingState, Point3 } from '../game/types';
import type { CarjackingSample } from '../game/carjacking';
import type { PersonModel } from './PersonModels';
import { poseFallenPerson, posePerson } from './PersonAnimation';

export const DRIVER_SCALE = .8;
const DOWN = new THREE.Vector3(0, -1, 0);
const temp = new THREE.Vector3(), direction = new THREE.Vector3(), bend = new THREE.Vector3(), elbow = new THREE.Vector3();
const inverse = new THREE.Quaternion();
const smooth = (value: number) => { const t = THREE.MathUtils.clamp(value, 0, 1); return t * t * (3 - 2 * t); };

export interface EntryHandTargets {
  handle: Point3;
  leftWheel: Point3;
  rightWheel: Point3;
  support: Point3;
}

/** Position actual articulated limbs at a world-space handhold. */
export function reachPersonHand(model: PersonModel, side: 'left' | 'right', world: Point3, amount = 1): void {
  const arm = side === 'left' ? model.leftArm : model.rightArm;
  const forearm = side === 'left' ? model.leftForearm : model.rightForearm;
  const hand = side === 'left' ? model.leftHand : model.rightHand;
  model.body.updateWorldMatrix(true, true);
  hand.getWorldPosition(temp);
  temp.lerp(new THREE.Vector3(world.x, world.y, world.z), THREE.MathUtils.clamp(amount, 0, 1));
  model.body.worldToLocal(temp);
  direction.copy(temp).sub(arm.position);
  const length = THREE.MathUtils.clamp(direction.length(), .035, .567);
  direction.normalize();
  const along = (.30 ** 2 - .27 ** 2 + length ** 2) / (2 * length);
  const away = Math.sqrt(Math.max(0, .30 ** 2 - along ** 2));
  bend.set(side === 'left' ? .55 : -.55, -.9, -.1);
  bend.addScaledVector(direction, -bend.dot(direction)).normalize();
  elbow.copy(arm.position).addScaledVector(direction, along).addScaledVector(bend, away);
  temp.copy(elbow).sub(arm.position).normalize();
  arm.quaternion.setFromUnitVectors(DOWN, temp);
  temp.copy(arm.position).addScaledVector(direction, length).sub(elbow).normalize();
  inverse.copy(arm.quaternion).invert(); temp.applyQuaternion(inverse);
  forearm.quaternion.setFromUnitVectors(DOWN, temp);
  hand.rotation.set(0, 0, side === 'left' ? -.13 : .13);
}

export function poseSeatedPerson(model: PersonModel, steer = 0): void {
  posePerson(model, 0, false);
  model.leftLeg.rotation.set(-1.34, 0, -.055);
  model.rightLeg.rotation.set(-1.30, 0, .045);
  model.leftShin.rotation.x = 1.42; model.rightShin.rotation.x = 1.39;
  model.leftArm.rotation.set(-.97 - steer * .25, 0, -.12);
  model.rightArm.rotation.set(-.97 + steer * .25, 0, .12);
  model.leftForearm.rotation.x = -.49; model.rightForearm.rotation.x = -.49;
  model.head.rotation.set(0, 0, 0); model.body.position.set(0, 0, 0);
}

export function poseCarjackingDriver(model: PersonModel, frame: CarjackingSample): void {
  const pose = frame.driver, seated = frame.driverSeated;
  model.root.visible = frame.driverVisible;
  model.root.scale.setScalar(DRIVER_SCALE);
  model.root.position.set(pose.x, pose.y + (1 - DRIVER_SCALE) * 1.99 * seated, pose.z);
  model.root.rotation.set(0, pose.yaw, 0);
  poseSeatedPerson(model);
  const out = 1 - seated;
  model.leftLeg.rotation.x *= seated; model.rightLeg.rotation.x *= seated;
  model.leftShin.rotation.x *= seated; model.rightShin.rotation.x *= seated;
  model.body.rotation.set(pose.pitch, 0, pose.roll);
  model.head.rotation.set(-.07, -.5 * seated, .08 * out);
  if (frame.phase === 'pull') {
    // Turn shoulders through the opening before the torso leaves the seat.
    // Tucked forearms cannot sweep through the open door's belt rail or panel.
    const turn = smooth(frame.progress / .45);
    model.root.rotation.y = pose.yaw + (turn - smooth(frame.progress)) * Math.PI / 2 + Math.sin(frame.progress * Math.PI) * .26;
    model.leftArm.rotation.set(.20, 0, -.18);
    model.rightArm.rotation.set(.20, 0, .18);
    model.leftForearm.rotation.x = -2; model.rightForearm.rotation.x = -2;
    model.head.rotation.set(-.07, .22 * (1 - turn), .08 * out);
    model.leftShin.rotation.x += Math.sin(frame.progress * Math.PI) * .65;
    model.rightLeg.rotation.x -= Math.sin(frame.progress * Math.PI) * .35;
  } else if (frame.phase === 'fall') {
    poseFallenPerson(model, smooth(frame.progress));
    model.body.rotation.set(pose.pitch, 0, pose.roll);
    model.leftArm.rotation.x = -.45; model.rightArm.rotation.x = -.8;
  } else if (frame.phase === 'enter' || frame.phase === 'close') {
    poseFallenPerson(model, 1);
    model.body.rotation.set(pose.pitch, 0, pose.roll);
  }
  model.root.updateWorldMatrix(true, true);
}

export function driverCollar(model: PersonModel, side: 'left' | 'right', toward?: Point3): THREE.Vector3 {
  model.body.updateWorldMatrix(true, false);
  if (!toward) return model.body.localToWorld(new THREE.Vector3(side === 'left' ? .17 : -.17, 1.54, .16));
  const collar = model.body.localToWorld(new THREE.Vector3(0, 1.54, 0));
  const facing = new THREE.Vector3(toward.x - collar.x, 0, toward.z - collar.z).normalize();
  const across = new THREE.Vector3(-facing.z, 0, facing.x);
  return collar.addScaledVector(facing, .18).addScaledVector(across, side === 'left' ? .14 : -.14);
}

/** Reach, pull, release, fold into the cabin, then pull the door shut. */
export function poseCarjackingPlayer(model: PersonModel, sequence: CarjackingState, frame: CarjackingSample,
  driver: PersonModel, targets: EntryHandTargets): void {
  const pose = frame.player, seated = frame.playerSeated;
  const scale = 1 - seated * (1 - DRIVER_SCALE);
  model.root.visible = true; model.root.scale.setScalar(scale);
  model.root.position.set(pose.x, pose.y + (1 - scale) * 1.99, pose.z);
  model.root.rotation.set(0, pose.yaw, 0);
  if (frame.phase === 'pull') {
    const collar = driver.body.localToWorld(new THREE.Vector3(0, 1.54, 0));
    const gripYaw = Math.atan2(collar.x - pose.x, collar.z - pose.z);
    model.root.rotation.y += Math.atan2(Math.sin(gripYaw - pose.yaw), Math.cos(gripYaw - pose.yaw)) * smooth(frame.progress / .10);
  }
  posePerson(model, sequence.elapsed * 11, frame.phase === 'approach');
  model.body.rotation.set(pose.pitch, 0, pose.roll);
  model.head.rotation.set(0, 0, 0);
  if (frame.phase === 'approach') return;
  model.body.position.set(0, 0, 0);
  // Duck before the head crosses the door frame; low sports roofs need a deeper crouch.
  // The knees absorb the height change while the same eye point drives first person.
  const eye = personEye(model);
  const outsideDoor = (eye.x - sequence.door.x) * Math.cos(sequence.carYaw) - (eye.z - sequence.door.z) * Math.sin(sequence.carYaw);
  const underRoof = smooth((.30 - outsideDoor) / .40);
  const crouch = ['open', 'pull', 'enter'].includes(frame.phase) ?
    Math.min(.5, Math.max(0, eye.y - sequence.seatEye.y)) * underRoof : 0;
  model.body.position.y = -crouch / scale;
  if (frame.phase === 'open') {
    reachPersonHand(model, 'right', targets.handle, smooth(frame.progress * 2));
  } else if (frame.phase === 'pull') {
    model.leftLeg.rotation.x = -.18; model.rightLeg.rotation.x = .25;
    model.leftShin.rotation.x = .22; model.rightShin.rotation.x = .12;
    reachPersonHand(model, 'left', driverCollar(driver, 'left', model.root.position));
    reachPersonHand(model, 'right', driverCollar(driver, 'right', model.root.position));
  } else if (frame.phase === 'fall') {
    model.leftArm.rotation.set(-.85 * (1 - smooth(frame.progress)), 0, -.25);
    model.rightArm.rotation.set(-.70 * (1 - smooth(frame.progress)), 0, .25);
  } else {
    const climb = frame.phase === 'enter' ? Math.sin(frame.progress * Math.PI) : 0;
    model.leftLeg.rotation.set(-1.34 * seated - climb * .3, 0, -.055 * seated);
    model.rightLeg.rotation.set(-1.30 * seated - climb * .75, 0, .045 * seated);
    model.leftShin.rotation.x = 1.42 * seated + climb * .55;
    model.rightShin.rotation.x = 1.39 * seated + climb * .12;
    if (frame.phase === 'enter') {
      reachPersonHand(model, 'left', targets.support, 1 - seated);
      reachPersonHand(model, 'right', targets.rightWheel, smooth(seated));
      if (seated > .75) reachPersonHand(model, 'left', targets.leftWheel, smooth((seated - .75) * 4));
    } else {
      reachPersonHand(model, 'right', targets.rightWheel);
      reachPersonHand(model, 'left', targets.handle, 1 - smooth((frame.progress - .62) / .38));
      reachPersonHand(model, 'left', targets.leftWheel, smooth((frame.progress - .62) / .38));
    }
  }
  if (crouch > 0) {
    const knee = Math.acos(THREE.MathUtils.clamp(1 - crouch / (.9 * scale), 0, 1));
    model.leftLeg.rotation.x -= knee; model.rightLeg.rotation.x -= knee;
    model.leftShin.rotation.x += knee * 2; model.rightShin.rotation.x += knee * 2;
  }
  model.root.updateWorldMatrix(true, true);
}

/** Ejected drivers land, brace against the road, stand up and can then flee. */
export function poseRecoveringDriver(model: PersonModel, progress: number): void {
  const rise = smooth((progress - .22) / .78);
  poseFallenPerson(model, 1 - rise);
  model.body.position.y = .29 * (1 - rise);
  model.leftLeg.rotation.x = -.65 * Math.sin(rise * Math.PI);
  model.leftShin.rotation.x = 1.0 * Math.sin(rise * Math.PI);
  model.rightShin.rotation.x = .35 * Math.sin(rise * Math.PI);
  model.leftArm.rotation.x = -.85 * Math.sin(rise * Math.PI);
  model.rightArm.rotation.x = -.55 * Math.sin(rise * Math.PI);
}

/** Show real reaching arms in first person without putting the head inside the lens. */
export function maskInteractionPlayer(model: PersonModel, firstPerson: boolean): void {
  model.head.visible = !firstPerson;
  model.leftLeg.visible = model.rightLeg.visible = !firstPerson;
  for (const child of model.body.children) if (child instanceof THREE.Mesh) child.visible = !firstPerson;
}

export function personEye(model: PersonModel): THREE.Vector3 {
  model.head.updateWorldMatrix(true, false);
  return model.head.localToWorld(new THREE.Vector3(0, .04, 0));
}
