import type { Point3, VehicleModel } from './types';
import { VEHICLE_SPECS } from './vehicles';

export interface VehicleCabin {
  width: number; back: number; front: number; roof: number; sill: number;
  hoodEnd: number; hoodTop: number; wheelRadius: number;
  eye: Point3;
}

/** Shared exterior, cockpit and entry dimensions in vehicle-local metres. */
export const VEHICLE_CABINS: Record<VehicleModel, VehicleCabin> = {
  sedan: { width: 1.84, back: -1.32, front: 1.06, roof: 1.93, sill: 1.16, hoodEnd: 2.18, hoodTop: 1.29,
    wheelRadius: .235, eye: { x: .35, y: 1.61, z: .15 } },
  truck: { width: 2.24, back: 1.15, front: 3.25, roof: 2.66, sill: 1.63, hoodEnd: 3.47, hoodTop: 1.92,
    wheelRadius: .255, eye: { x: .45, y: 2.21, z: 2.30 } },
  pickup: { width: 2.00, back: -.38, front: 1.62, roof: 2.24, sill: 1.32, hoodEnd: 2.76, hoodTop: 1.50,
    wheelRadius: .245, eye: { x: .40, y: 1.85, z: .78 } },
  hatchback: { width: 1.76, back: -1.43, front: .86, roof: 2.10, sill: 1.15, hoodEnd: 1.82, hoodTop: 1.23,
    wheelRadius: .22, eye: { x: .32, y: 1.69, z: .10 } },
  sport: { width: 1.85, back: -1.40, front: .82, roof: 1.70, sill: 1.01, hoodEnd: 2.23, hoodTop: 1.03,
    wheelRadius: .23, eye: { x: .35, y: 1.37, z: .03 } },
  armored: { width: 2.30, back: .02, front: 2.44, roof: 2.65, sill: 1.69, hoodEnd: 3.02, hoodTop: 1.62,
    wheelRadius: .255, eye: { x: .46, y: 2.21, z: 1.37 } },
};

export interface VehicleAccess {
  seatEye: Point3;
  /** Root for an unscaled person whose eyes are 1.99 m above its origin. */
  seatRoot: Point3;
  doorHinge: Point3;
  doorHandle: Point3;
  doorway: Point3;
  approach: Point3;
  pullEnd: Point3;
  doorWidth: number;
  doorOpenAngle: number;
  doorBack: number;
  bodyHalfWidth: number;
  doorBottom: number;
}

/** +Z forward, +X anatomical left. Add the vehicle root's .12 m road offset. */
export function getVehicleAccess(model: VehicleModel): VehicleAccess {
  const cabin = VEHICLE_CABINS[model], spec = VEHICLE_SPECS[model];
  const bodyHalfWidth = { sedan: 1.09, truck: 1.21, pickup: 1.11, hatchback: .955, sport: 1.065, armored: 1.22 }[model];
  const front = cabin.front - .08;
  const back = Math.max(cabin.back + .10, cabin.eye.z - .62);
  const seatRoot = { ...cabin.eye, y: cabin.eye.y - 1.99 };
  return {
    seatEye: { ...cabin.eye }, seatRoot,
    doorHinge: { x: bodyHalfWidth, y: cabin.sill - .35, z: front },
    doorHandle: { x: bodyHalfWidth + .026, y: cabin.sill - .07, z: back + .24 },
    doorway: { x: cabin.width / 2 + .08, y: seatRoot.y, z: cabin.eye.z },
    approach: { x: spec.width / 2 + .72, y: 0, z: cabin.eye.z - .12 },
    pullEnd: { x: spec.width / 2 + 1.45, y: 0, z: cabin.eye.z - .80 },
    doorWidth: front - back, doorOpenAngle: 1.18, doorBack: back, bodyHalfWidth,
    doorBottom: Math.max(cabin.eye.y - 1.04, model === 'sport' ? .48 : .55) + .026,
  };
}
