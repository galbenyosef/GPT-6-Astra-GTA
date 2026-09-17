import * as THREE from 'three';
import type { Vehicle } from '../game/types';
import { VEHICLE_CABINS } from '../game/vehicleAccess';
import type { VehiclePart } from './VehicleModels';

export interface VehicleCockpitNode {
  root: THREE.Group;
  steeringWheel: THREE.Group;
  leftGrip: THREE.Group;
  rightGrip: THREE.Group;
  /** Driver eye in vehicle-local metres. +Z is forward; anatomical left is +X. */
  seatOffset: { x: number; y: number; z: number };
}

/** Open-glazed interior for first-person driving; every mesh uses shared part caches. */
export function createVehicleCockpit(vehicle: Vehicle, part: VehiclePart, options: { entry?: boolean } = {}): VehicleCockpitNode {
  const c = VEHICLE_CABINS[vehicle.model];
  const root = new THREE.Group();
  root.name = `cockpit-${vehicle.model}-${vehicle.id}`;
  const seatOffset = { ...c.eye };
  const police = vehicle.kind === 'police';
  const paint = vehicle.model === 'armored' ? '#243a48' : police ? '#eff0db' : vehicle.color;
  const dark = '#202d31', rubber = '#172329', trim = '#425153', chrome = '#bdc9c4';
  const cloth = vehicle.model === 'sport' ? '#493d39' : vehicle.model === 'hatchback' ? '#626954' : '#3d4d50';
  const accent = vehicle.model === 'sport' ? '#b75f4c' : '#99b4ab';
  const floor = c.eye.y - (options.entry ? 1.24 : 1.06);
  const dashTop = Math.min(c.eye.y - .33, c.sill + .15);
  const dashRear = c.front - .23;
  const upperFront = c.front - (c.roof - c.sill) * .28;
  const upperBack = c.back + (c.roof - c.sill) * .20;

  const box = (name: string, color: string, x: number, y: number, z: number, w: number, h: number, d: number, parent: THREE.Object3D = root) => {
    const mesh = part(parent, 'box', color, x, y, z, w, h, d, 0, false);
    mesh.name = name;
    return mesh;
  };
  const rod = (name: string, color: string, a: THREE.Vector3, b: THREE.Vector3, radius: number, parent: THREE.Object3D = root) => {
    const direction = b.clone().sub(a);
    const center = a.clone().add(b).multiplyScalar(.5);
    const mesh = part(parent, 'cylinder', color, center.x, center.y, center.z, radius, direction.length(), radius, 0, false);
    mesh.name = name;
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    return mesh;
  };

  box('cabin-floor', rubber, 0, floor, (c.back + c.front) / 2, c.width, .08, c.front - c.back);
  box('transmission-tunnel', dark, 0, floor + .12, c.eye.z + .30, .27, .26, 1.02);
  box('dashboard-body', dark, 0, dashTop - .15, c.front - .105, c.width - .11, .30, .24);
  box('dashboard-top', trim, 0, dashTop + .018, c.front - .10, c.width - .10, .05, .25);
  box('dashboard-inlay', accent, 0, dashTop - .105, dashRear - .008, c.width - .22, .026, .019);
  box('glovebox', '#344448', -c.width * .28, dashTop - .20, dashRear - .025, c.width * .29, .15, .025);
  box('glovebox-latch', chrome, -c.width * .28, dashTop - .157, dashRear - .043, .12, .025, .016);

  // Body-colored bonnet remains visible after the opaque exterior is hidden.
  const hoodStart = c.front - .035;
  box('hood', paint, 0, c.hoodTop - .07, (hoodStart + c.hoodEnd) / 2,
    Math.min(vehicle.width - .19, c.width + .18), .14, c.hoodEnd - hoodStart);
  for (const side of [-1, 1]) {
    box('hood-crease', vehicle.model === 'sport' ? '#eee8d5' : paint, side * (vehicle.model === 'sport' ? .28 : c.width * .35),
      c.hoodTop + .006, (hoodStart + c.hoodEnd) / 2, vehicle.model === 'sport' ? .20 : .035, .016, c.hoodEnd - hoodStart - .035);
    box('windshield-wiper', rubber, side * .34, c.sill + .04, c.front + .014, .52, .025, .042);
  }

  // Roof and narrow A/B pillars frame empty windshield and side-window openings.
  box('headliner', '#65716b', 0, c.roof - .012, (upperBack + upperFront) / 2, c.width * .88, .055, upperFront - upperBack);
  box('windshield-header', dark, 0, c.roof - .052, upperFront, c.width * .91, .065, .082);
  box('rear-window-header', dark, 0, c.roof - .052, upperBack, c.width * .91, .065, .082);
  box('windshield-sill', dark, 0, c.sill + .045, c.front, c.width, .075, .07);
  for (const side of [-1, 1]) {
    const lowerX = side * c.width / 2, upperX = side * c.width * .455;
    rod('windshield-a-pillar', '#697671', new THREE.Vector3(lowerX, c.sill, c.front), new THREE.Vector3(upperX, c.roof - .04, upperFront), .043);
    rod('rear-pillar', '#697671', new THREE.Vector3(lowerX, c.sill, c.back), new THREE.Vector3(upperX, c.roof - .04, upperBack), .046);
    box('door-panel', dark, lowerX, (floor + c.sill) / 2, (c.back + c.front) / 2, .09, c.sill - floor, c.front - c.back);
    box('door-upholstery', cloth, lowerX - side * .052, c.sill - .20, c.eye.z + .19, .03, .24, .69);
    box('door-armrest', trim, lowerX - side * .087, c.sill - .18, c.eye.z + .19, .13, .065, .52);
    box('door-latch', chrome, lowerX - side * .06, c.sill - .058, c.eye.z + .40, .028, .043, .18);
    box('window-switch', rubber, lowerX - side * .10, c.sill - .141, c.eye.z + .32, .07, .018, .07);
    box('window-sill', trim, lowerX - side * .008, c.sill + .013, (c.back + c.front) / 2, .09, .055, c.front - c.back);
    if (vehicle.model === 'sedan' || vehicle.model === 'hatchback') {
      box('door-b-pillar', dark, upperX, (c.sill + c.roof) / 2, c.eye.z - .32, .063, c.roof - c.sill, .065);
    }
    const speaker = part(root, 'cylinder', '#24353a', lowerX - side * .055, floor + .26, c.eye.z + .5, .092, .024, .092, 0, false);
    speaker.name = 'door-speaker'; speaker.rotation.z = Math.PI / 2;
    const mirrorX = side * Math.min(c.width / 2 + .13, vehicle.width / 2 - .085);
    box('side-mirror-stalk', rubber, lowerX + side * .052, c.sill + .17, c.front - .12, .14, .037, .045);
    box('side-mirror-housing', paint, mirrorX, c.sill + .20, c.front - .13, .16, .17, .24);
    box('side-mirror-face', '#89a5a7', mirrorX, c.sill + .20, c.front - .255, .13, .125, .018);
  }

  const seat = (x: number, z: number, rear = false) => {
    const cushion = c.eye.y - .92, width = rear ? .55 : .57;
    box(rear ? 'rear-seat-cushion' : 'front-seat-cushion', cloth, x, cushion, z, width, .17, rear ? .48 : .62);
    box('seat-back', cloth, x, cushion + .32, z - .27, width, .61, .14);
    for (const side of [-1, 1]) {
      box('seat-bolster', trim, x + side * (width / 2 - .025), cushion + .28, z - .185, .07, .47, .14);
      rod('headrest-post', chrome, new THREE.Vector3(x + side * .105, cushion + .55, z - .27), new THREE.Vector3(x + side * .105, cushion + .72, z - .27), .014);
    }
    box('headrest', cloth, x, cushion + .78, z - .27, .33, .24, .13);
    box('seat-seam', accent, x, cushion + .11, z + .035, .025, .015, .43);
  };
  seat(c.eye.x, c.eye.z);
  seat(-c.eye.x - .07, c.eye.z);
  if (vehicle.model === 'sedan' || vehicle.model === 'hatchback') {
    for (const side of [-1, 1]) seat(side * c.width * .23, c.back + .36, true);
    box('rear-parcel-shelf', cloth, 0, c.sill - .03, c.back + .04, c.width * .91, .09, .30);
  } else if (vehicle.model === 'truck' || vehicle.model === 'armored') {
    box('cargo-bulkhead', cloth, 0, (floor + c.roof) / 2, c.back, c.width * .96, c.roof - floor, .095);
    for (const x of [-.60, 0, .60]) box('bulkhead-rib', trim, x, (floor + c.roof) / 2, c.back + .055, .035, c.roof - floor - .1, .032);
  } else {
    box('rear-cabin-panel', cloth, 0, (floor + c.sill) / 2, c.back, c.width * .96, c.sill - floor, .10);
  }

  // Circular instrument faces point back toward the driver; markings use cached boxes.
  for (const [index, offset] of [-.135, .135].entries()) {
    const x = c.eye.x + offset, y = dashTop - .085, z = dashRear - .027;
    const bezel = part(root, 'cylinder', chrome, x, y, z, .101, .032, .101, 0, false);
    bezel.name = 'instrument-bezel'; bezel.rotation.x = Math.PI / 2;
    const face = part(root, 'cylinder', rubber, x, y, z - .019, .088, .008, .088, 0, false);
    face.name = 'instrument-face'; face.rotation.x = Math.PI / 2;
    for (let tick = 0; tick < 9; tick++) {
      const angle = -.78 * Math.PI + tick / 8 * Math.PI * 1.56;
      const mark = box('instrument-tick', '#d1e0d3', x + Math.sin(angle) * .065, y + Math.cos(angle) * .065, z - .026, .01, .018, .006);
      mark.rotation.z = -angle;
    }
    const needle = box(index ? 'tachometer-needle' : 'speedometer-needle', '#e7b466', x - .027, y - .011, z - .031, .061, .008, .006);
    needle.rotation.z = .43;
  }
  for (const side of [-1, 1]) {
    const x = side * c.width * .39;
    box('dashboard-vent', rubber, x, dashTop - .076, dashRear - .034, .17, .105, .026);
    for (const shift of [-.03, 0, .03]) box('vent-slat', '#71827d', x, dashTop - .076 + shift, dashRear - .052, .145, .011, .012);
  }
  box('center-console', dark, -.09, dashTop - .28, dashRear - .042, .28, .31, .12);
  box('radio-display', '#718f89', -.09, dashTop - .20, dashRear - .108, .19, .061, .018);
  for (const x of [-.18, -.09, 0]) box('console-switch', chrome, x, dashTop - .29, dashRear - .11, .04, .025, .019);
  box('center-armrest', cloth, 0, floor + .34, c.eye.z - .01, .23, .14, .43);
  rod('gear-stick', chrome, new THREE.Vector3(-.02, floor + .22, c.eye.z + .42), new THREE.Vector3(-.02, floor + .52, c.eye.z + .35), .018);
  const shifter = part(root, 'sphere', rubber, -.02, floor + .53, c.eye.z + .35, .054, .045, .06, 0, false);
  shifter.name = 'gear-knob';

  const wheelTilt = new THREE.Group();
  wheelTilt.name = 'steering-column-tilt';
  const wheelZ = Math.min(c.eye.z + .58, c.front - .29);
  wheelTilt.position.set(c.eye.x, c.eye.y - .31, wheelZ);
  wheelTilt.rotation.x = vehicle.model === 'truck' ? .34 : .20;
  root.add(wheelTilt);
  const steeringWheel = new THREE.Group();
  steeringWheel.name = 'steering-wheel';
  wheelTilt.add(steeringWheel);
  const radius = c.wheelRadius;
  for (let segment = 0; segment < 24; segment++) {
    const a = segment / 24 * Math.PI * 2, b = (segment + 1) / 24 * Math.PI * 2;
    rod('steering-rim', rubber, new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0),
      new THREE.Vector3(Math.cos(b) * radius, Math.sin(b) * radius, 0), .022, steeringWheel);
  }
  for (const angle of [-Math.PI / 2, Math.PI / 6, Math.PI * 5 / 6]) {
    rod('steering-spoke', trim, new THREE.Vector3(0, 0, .004), new THREE.Vector3(Math.cos(angle) * radius * .90, Math.sin(angle) * radius * .90, 0), .021, steeringWheel);
  }
  box('steering-hub', dark, 0, 0, -.012, .14, .105, .052, steeringWheel);
  box('steering-badge', chrome, 0, .008, -.041, .048, .033, .007, steeringWheel);
  rod('steering-column', dark, new THREE.Vector3(c.eye.x, c.eye.y - .31, wheelZ + .04), new THREE.Vector3(c.eye.x, dashTop - .21, dashRear + .12), .051);
  const leftGrip = new THREE.Group(), rightGrip = new THREE.Group();
  leftGrip.name = 'driver-left-grip'; rightGrip.name = 'driver-right-grip';
  leftGrip.position.set(radius, 0, 0); rightGrip.position.set(-radius, 0, 0);
  steeringWheel.add(leftGrip, rightGrip);

  box('rearview-mirror-stem', dark, 0, c.roof - .10, c.front - .30, .025, .14, .025);
  box('rearview-mirror-housing', rubber, 0, c.roof - .19, c.front - .30, .31, .12, .047);
  box('rearview-mirror-face', '#8ba4a3', 0, c.roof - .19, c.front - .327, .27, .081, .014);
  if (police) {
    box('police-radio', rubber, -.30, dashTop - .13, dashRear - .09, .29, .14, .13);
    box('police-radio-screen', '#819d97', -.30, dashTop - .105, dashRear - .164, .18, .037, .019);
    for (const [index, color] of ['#bb6457', '#698eac', '#c9cbb1'].entries()) {
      box('siren-control', color, -.38 + index * .075, dashTop - .164, dashRear - .165, .032, .022, .022);
    }
    box('radio-handset', dark, -.51, dashTop - .17, dashRear - .11, .065, .18, .063);
  }
  if (options.entry) {
    // The exterior supplies the roof, bonnet, pillars and articulated driver door.
    const exteriorNames = new Set(['hood', 'hood-crease', 'windshield-wiper', 'headliner', 'windshield-header',
      'rear-window-header', 'windshield-sill', 'windshield-a-pillar', 'rear-pillar', 'door-b-pillar',
      'side-mirror-stalk', 'side-mirror-housing', 'side-mirror-face']);
    const doorNames = new Set(['door-panel', 'door-upholstery', 'door-armrest', 'door-latch', 'window-switch', 'window-sill', 'door-speaker']);
    const removed: THREE.Object3D[] = [];
    root.traverse(object => {
      if (exteriorNames.has(object.name) || object.position.x > 0 && doorNames.has(object.name)) removed.push(object);
    });
    removed.forEach(object => object.removeFromParent());
  }
  return { root, steeringWheel, leftGrip, rightGrip, seatOffset };
}
