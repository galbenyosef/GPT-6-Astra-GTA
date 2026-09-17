import { PERSON_SOLE_BOUNDS, type PersonModel } from './PersonModels';
import type { World } from '../game/types';

/** Match the authored road, curb, sidewalk and lot surfaces beneath a person's feet. */
export function personGroundHeight(world: Pick<World, 'roads' | 'roadWidth' | 'size'>, x: number, z: number): number {
  const roadHalf = world.roadWidth / 2;
  let dx = Infinity, dz = Infinity;
  for (const road of world.roads) {
    dx = Math.min(dx, Math.abs(x - road));
    dz = Math.min(dz, Math.abs(z - road));
  }
  const half = world.size / 2;
  const promenade = Math.abs(x) <= half && Math.abs(z) <= half &&
    (Math.abs(x) >= half - 6.6 || Math.abs(z) >= half - 6.6) ? .22 : .04;
  if (dx <= roadHalf || dz <= roadHalf) return Math.max(.11, promenade);
  const edge = half - 1;
  const besideX = dx <= roadHalf + 4.7 && Math.abs(z) <= edge;
  const besideZ = dz <= roadHalf + 4.7 && Math.abs(x) <= edge;
  if ((besideX && dx >= roadHalf + .01 && dx <= roadHalf + .25) ||
      (besideZ && dz >= roadHalf + .01 && dz <= roadHalf + .25)) return .28;
  return besideX || besideZ ? .24 : promenade;
}

/** Pose the shared joints; world movement and collisions remain in the simulation. */
export function posePerson(model: PersonModel, phase: number, moving: boolean, running = false): void {
  const stride = moving ? Math.sin(phase) * (running ? .72 : .48) : 0;
  const knee = running ? 1.05 : .62;
  model.leftLeg.rotation.set(stride, 0, 0);
  model.rightLeg.rotation.set(-stride, 0, 0);
  model.leftShin.rotation.set(moving ? Math.max(0, -Math.cos(phase)) * knee : 0, 0, 0);
  model.rightShin.rotation.set(moving ? Math.max(0, Math.cos(phase)) * knee : 0, 0, 0);
  model.leftArm.rotation.set(-stride * .8, 0, -.035);
  model.rightArm.rotation.set(stride * .8, 0, .035);
  const elbow = running ? -.8 : -.12;
  model.leftForearm.rotation.set(elbow - Math.max(0, stride) * .3, 0, 0);
  model.rightForearm.rotation.set(elbow - Math.max(0, -stride) * .3, 0, 0);
  model.leftHand.rotation.set(0, 0, 0);
  model.rightHand.rotation.set(0, 0, 0);
  model.head.rotation.set(moving ? Math.sin(phase * 2) * .012 : -.012, Math.sin(phase * .21) * (moving ? .035 : .11), 0);
  model.body.position.set(0, moving ? Math.abs(Math.sin(phase)) * .045 : Math.sin(phase * .2) * .01, 0);
  model.body.rotation.set(running ? .12 : 0, 0, 0);
  if (moving) {
    const lean = model.body.rotation.x, sole = PERSON_SOLE_BOUNDS;
    const footHeight = (leg: PersonModel['leftLeg'], shin: PersonModel['leftShin']) => {
      const thighAngle = lean + leg.rotation.x, ankleAngle = thighAngle + shin.rotation.x;
      const cosine = Math.cos(ankleAngle), sine = Math.sin(ankleAngle);
      return leg.position.y * Math.cos(lean) + shin.position.y * Math.cos(thighAngle) +
        Math.min(sole.minY * cosine, sole.maxY * cosine) - Math.max(sole.minZ * sine, sole.maxZ * sine);
    };
    // Rigid shoes rotate with the shin; lift the stride enough to keep both soles above the paving.
    const lowestFoot = Math.min(footHeight(model.leftLeg, model.leftShin), footHeight(model.rightLeg, model.rightShin));
    model.body.position.y = Math.max(model.body.position.y, -lowestFoot + .002);
  }
}

/** Explicitly reset every joint so a fall cannot inherit a running or aiming pose. */
export function poseFallenPerson(model: PersonModel, fall: number): void {
  const amount = Math.max(0, Math.min(1, fall));
  model.body.position.set(0, .29 * amount, 0);
  model.body.rotation.set(Math.PI / 2 * amount, 0, 0);
  model.head.rotation.set(0, 0, -.08 * amount);
  model.leftArm.rotation.set(0, 0, -.28 * amount);
  model.rightArm.rotation.set(0, 0, .2 * amount);
  model.leftForearm.rotation.set(-.08 * amount, 0, 0);
  model.rightForearm.rotation.set(-.12 * amount, 0, 0);
  model.leftHand.rotation.set(0, 0, 0);
  model.rightHand.rotation.set(0, 0, 0);
  model.leftLeg.rotation.set(0, 0, .09 * amount);
  model.rightLeg.rotation.set(0, 0, -.05 * amount);
  model.leftShin.rotation.set(.1 * amount, 0, 0);
  model.rightShin.rotation.set(.06 * amount, 0, 0);
}
