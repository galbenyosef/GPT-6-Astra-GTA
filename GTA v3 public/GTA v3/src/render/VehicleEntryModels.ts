import * as THREE from 'three';
import type { Point3, Vehicle } from '../game/types';
import { getVehicleAccess, VEHICLE_CABINS } from '../game/vehicleAccess';
import type { VehiclePart } from './VehicleModels';
import { createVehicleCockpit } from './VehicleCockpit';

export interface VehicleEntryNode {
  door: THREE.Group;
  interiorRoot: THREE.Group;
  windows: THREE.Mesh[];
  seatEye: Point3;
  handle: THREE.Group;
  /** Opens the real driver door; reveal keeps the occupant visible before/after its swing. */
  setOpen(amount: number, revealInterior?: boolean): void;
}

/** Split a formerly solid body around the actual cabin instead of masking a door on a box. */
export function addHollowVehicleBody(vehicle: Vehicle, root: THREE.Group, part: VehiclePart, color: string,
  x: number, y: number, z: number, width: number, height: number, depth: number): void {
  const c = VEHICLE_CABINS[vehicle.model], access = getVehicleAccess(vehicle.model);
  const front = z + depth / 2, back = z - depth / 2;
  const cabinBack = Math.max(back, c.back), cabinFront = Math.min(front, c.front);
  const add = (name: string, px: number, py: number, start: number, end: number, w: number, h: number) => {
    if (end - start < .001 || w < .001 || h < .001) return;
    const mesh = part(root, 'box', color, px, py, (start + end) / 2, w, h, end - start);
    mesh.name = name;
  };
  if (cabinFront <= cabinBack) { add('body-solid-section', x, y, back, front, width, height); return; }
  add('body-front-section', x, y, cabinFront, front, width, height);
  add('body-rear-section', x, y, back, cabinBack, width, height);
  const bottom = y - height / 2, top = y + height / 2;
  const floorTop = Math.min(top, c.eye.y - 1.24);
  if (floorTop > bottom) add('cabin-underfloor', x, (bottom + floorTop) / 2, cabinBack, cabinFront, width, floorTop - bottom);
  const wallBottom = Math.max(bottom, floorTop), wallHeight = top - wallBottom;
  const wallY = (wallBottom + top) / 2, thickness = .095;
  add('passenger-body-side', x - width / 2 + thickness / 2, wallY, cabinBack, cabinFront, thickness, wallHeight);
  add('driver-rear-quarter', x + width / 2 - thickness / 2, wallY, cabinBack, Math.min(cabinFront, access.doorBack), thickness, wallHeight);
  add('driver-front-quarter', x + width / 2 - thickness / 2, wallY, Math.max(cabinBack, access.doorHinge.z), cabinFront, thickness, wallHeight);
  const rockerTop = Math.min(top, access.doorBottom), rockerBottom = Math.max(bottom, floorTop);
  add('driver-door-rocker', x + width / 2 - thickness / 2, (rockerBottom + rockerTop) / 2,
    Math.max(cabinBack, access.doorBack), Math.min(cabinFront, access.doorHinge.z), thickness, rockerTop - rockerBottom);
}

/** Articulated side door plus a lazily constructed cabin, using only cached parts. */
export function createVehicleEntry(vehicle: Vehicle, root: THREE.Group, part: VehiclePart, fixedWindows: THREE.Mesh[]): VehicleEntryNode {
  const c = VEHICLE_CABINS[vehicle.model], a = getVehicleAccess(vehicle.model);
  const paint = vehicle.kind === 'police' ? '#eff0db' : vehicle.color;
  const trim = '#293c43', chrome = '#c5cfca', glass = '#416779';
  const door = new THREE.Group(); door.name = 'driver-door';
  door.position.set(a.doorHinge.x, a.doorHinge.y, a.doorHinge.z); root.add(door);
  const interiorRoot = new THREE.Group(); interiorRoot.name = 'entry-interior'; interiorRoot.visible = false; root.add(interiorRoot);
  const windows = [...fixedWindows];
  const box = (name: string, color: string, x: number, y: number, z: number, w: number, h: number, d: number) => {
    const mesh = part(door, 'box', color, x - door.position.x, y - door.position.y, z - door.position.z, w, h, d);
    mesh.name = name; return mesh;
  };
  const rod = (name: string, color: string, from: THREE.Vector3, to: THREE.Vector3, radius: number) => {
    const delta = to.clone().sub(from), center = from.clone().add(to).multiplyScalar(.5).sub(door.position);
    const mesh = part(door, 'cylinder', color, center.x, center.y, center.z, radius, delta.length(), radius);
    mesh.name = name; mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); return mesh;
  };
  const front = a.doorHinge.z, back = a.doorBack, centerZ = (front + back) / 2;
  const bottom = a.doorBottom;
  const doorTop = c.sill + .015;
  box('driver-door-outer-panel', paint, a.bodyHalfWidth - .012, (bottom + doorTop) / 2, centerZ, .065, doorTop - bottom, a.doorWidth - .023);
  box('driver-door-inner-panel', '#26373d', a.bodyHalfWidth - .039, (bottom + doorTop) / 2, centerZ, .021, doorTop - bottom - .045, a.doorWidth - .078);
  box('driver-door-upholstery', '#536364', a.bodyHalfWidth - .054, c.sill - .19, centerZ, .022, .20, a.doorWidth * .60);
  box('driver-door-armrest', '#34494f', a.bodyHalfWidth - .105, c.sill - .20, centerZ, .12, .061, a.doorWidth * .47);
  box('driver-door-inner-handle', chrome, a.bodyHalfWidth - .061, c.sill - .07, front - .29, .029, .046, .17);
  box('driver-door-lower-trim', trim, a.bodyHalfWidth + .023, bottom + .14, centerZ, .015, .074, a.doorWidth - .055);
  if (vehicle.kind === 'police') box('driver-door-police-stripe', '#314751', a.bodyHalfWidth + .023, c.sill - .20, centerZ, .016, .27, a.doorWidth - .05);

  const lowerX = c.width / 2, upperX = c.width * .455;
  const upperY = c.roof - .075, lowerY = c.sill + .025;
  const upperFront = Math.max(back + .48, c.front - (c.roof - c.sill) * .28 - .035);
  const upperBack = back + .025;
  rod('driver-window-front-frame', paint, new THREE.Vector3(lowerX, lowerY, front), new THREE.Vector3(upperX, upperY, upperFront), .029);
  rod('driver-window-rear-frame', paint, new THREE.Vector3(lowerX, lowerY, back), new THREE.Vector3(upperX, upperY, upperBack), .031);
  rod('driver-window-top-frame', paint, new THREE.Vector3(upperX, upperY, upperBack), new THREE.Vector3(upperX, upperY, upperFront), .028);
  // The belt rail links the narrower upper glazing to the wider stamped door skin.
  box('driver-window-belt-rail', paint, (a.bodyHalfWidth + lowerX) / 2, c.sill + .027, centerZ,
    a.bodyHalfWidth - lowerX + .061, .07, a.doorWidth - .008);
  const pane = box('driver-window-glass', glass, (lowerX + upperX) / 2 + .005, (lowerY + upperY) / 2,
    (upperBack + upperFront) / 2, .013, upperY - lowerY - .065, upperFront - upperBack - .075);
  pane.rotation.z = Math.atan2(lowerX - upperX, upperY - lowerY);
  windows.push(pane);

  box('driver-door-handle', chrome, a.doorHandle.x, a.doorHandle.y, a.doorHandle.z, .016, .052, .23);
  const handle = new THREE.Group(); handle.name = 'driver-door-handle-anchor';
  handle.position.set(a.doorHandle.x - door.position.x, a.doorHandle.y - door.position.y, a.doorHandle.z - door.position.z); door.add(handle);
  const mirrorX = Math.min(c.width / 2 + .13, vehicle.width / 2 - .085);
  box('driver-mirror-stalk', trim, (lowerX + mirrorX) / 2, c.sill + .17, front - .08, mirrorX - lowerX + .09, .045, .052);
  box('driver-mirror-housing', paint, mirrorX, c.sill + .22, front - .075, .16, .18, .23);
  box('driver-mirror-face', '#86a6ab', mirrorX, c.sill + .22, front - .199, .12, .13, .015);

  let interiorBuilt = false;
  const setOpen = (amount: number, revealInterior = false) => {
    const open = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    door.rotation.y = -a.doorOpenAngle * open;
    const visible = revealInterior || open > .0001;
    if (visible && !interiorBuilt) {
      const interior = createVehicleCockpit(vehicle, part, { entry: true });
      interiorRoot.add(interior.root); interiorBuilt = true;
    }
    interiorRoot.visible = visible;
    for (const window of windows) window.visible = !visible;
  };
  return { door, interiorRoot, windows, seatEye: { ...a.seatEye }, handle, setOpen };
}
