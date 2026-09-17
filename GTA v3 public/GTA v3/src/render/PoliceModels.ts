import * as THREE from 'three';
import type { Vehicle } from '../game/types';
import { VEHICLE_SPECS } from '../game/vehicles';
import type { CarNode, VehiclePart } from './VehicleModels';

export interface PoliceHelicopterNode {
  root: THREE.Group;
  mainRotor: THREE.Group;
  tailRotor: THREE.Group;
  gun: THREE.Group;
  muzzle: THREE.Group;
}

// All parts go through the renderer's primitive/material caches. Model builders
// own only transforms, so creating reinforcements never allocates GPU geometry.
function modelParts(root: THREE.Group, part: VehiclePart) {
  const box = (name: string, color: string, x: number, y: number, z: number,
    w: number, h: number, d: number, parent: THREE.Object3D = root, shadow = true) => {
    const mesh = part(parent, 'box', color, x, y, z, w, h, d, 0, shadow);
    mesh.name = name;
    return mesh;
  };
  const rod = (name: string, color: string, a: THREE.Vector3, b: THREE.Vector3, radius: number,
    parent: THREE.Object3D = root, shadow = true) => {
    const delta = b.clone().sub(a), center = a.clone().add(b).multiplyScalar(.5);
    const mesh = part(parent, 'cylinder', color, center.x, center.y, center.z, radius, delta.length(), radius, 0, shadow);
    mesh.name = name;
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    return mesh;
  };
  return { box, rod };
}

/** Original six-wheel tactical carrier. Vehicle-local +Z is forward. */
export function createArmoredVehicle(vehicle: Vehicle, part: VehiclePart): CarNode {
  const root = new THREE.Group(); root.name = `armored-${vehicle.id}`;
  const { box, rod } = modelParts(root, part);
  const hull = '#243a48', plate = '#344d5a', edge = '#647780', dark = '#15242b', glass = '#567c88';
  const wheels: THREE.Group[] = [], frontWheels: THREE.Group[] = [];
  const wheelRadius = VEHICLE_SPECS.armored.wheelRadius;

  box('armored-frame', dark, 0, .66, 0, 2.12, .31, 6.10);
  box('lower-hull', hull, 0, 1.11, -.16, 2.40, .70, 5.82);
  box('troop-compartment', hull, 0, 1.87, -1.02, 2.39, 1.90, 3.94);
  box('troop-roof', plate, 0, 2.87, -1.02, 2.48, .14, 3.98);
  const cab = part(root, 'cabin', hull, 0, 2.06, 1.15, 2.46, 1.14, 2.68);
  cab.name = 'sloped-armored-cab';
  box('cab-roof', plate, 0, 2.66, 1.15, 2.17, .13, 1.83);
  const hood = box('sloping-bonnet', plate, 0, 1.53, 2.64, 2.37, .22, .91);
  hood.rotation.x = .13;
  box('radiator-armor', hull, 0, 1.16, 3.02, 2.35, .58, .18);
  box('front-grille', dark, 0, 1.19, 3.119, 1.12, .34, .018);
  for (const y of [1.07, 1.18, 1.29]) box('grille-louver', edge, 0, y, 3.136, 1.04, .028, .016, root, false);
  box('front-bumper', dark, 0, .76, 3.075, 2.57, .25, .19);
  box('rear-bumper', dark, 0, .75, -3.07, 2.52, .23, .20);
  box('ram-crossbar', edge, 0, 1.50, 3.115, 2.39, .085, .095);
  for (const side of [-1, 1]) {
    box('ram-upright', edge, side * .76, 1.12, 3.12, .085, .81, .11);
    box('headlamp-recess', dark, side * .93, 1.27, 3.118, .41, .30, .032);
    box('headlamp', '#e8f1d5', side * .93, 1.27, 3.141, .29, .17, .018, root, false);
    box('rear-stop-lamp', '#d95551', side * 1.065, 1.00, -3.078, .14, .29, .028, root, false);
    box('rear-reversing-lamp', '#c4d1c5', side * 1.065, .99, -3.095, .10, .066, .015, root, false);
  }

  // Two independently framed bullet-resistant windshield panes follow the slope.
  const screenAngle = -Math.atan2(2.68 * .18, 1.14);
  for (const side of [-1, 1]) {
    const frame = box('windshield-armor-frame', dark, side * .525, 2.11, 2.229, .985, .63, .055);
    frame.rotation.x = screenAngle;
    const pane = box('armored-windshield', glass, side * .525, 2.117, 2.264, .84, .45, .018, root, false);
    pane.rotation.x = screenAngle;
    const brow = box('windshield-brow', edge, side * .525, 2.441, 2.117, 1.0, .075, .085);
    brow.rotation.x = screenAngle;
    box('cab-door', plate, side * 1.195, 1.58, 1.27, .055, .80, 1.70);
    box('cab-window-frame', dark, side * 1.141, 2.19, 1.24, .072, .50, 1.21);
    box('cab-window', glass, side * 1.18, 2.19, 1.24, .015, .33, .99, root, false);
    box('armored-door-handle', edge, side * 1.242, 1.80, .74, .045, .063, .24, root, false);
    box('cab-step', dark, side * 1.25, .73, 1.20, .20, .12, 1.36);
    box('mirror-arm', dark, side * 1.266, 2.18, 1.97, .23, .055, .06);
    box('mirror-housing', hull, side * 1.318, 2.24, 2.02, .14, .27, .19);
    box('mirror-face', '#89a7a9', side * 1.318, 2.24, 1.917, .10, .20, .014, root, false);

    // Raised, separate armor plates and narrow observation ports break up the hull.
    for (const z of [-2.37, -1.20, -.03]) {
      box('troop-side-armor', plate, side * 1.232, 1.92, z, .095, 1.41, 1.09);
      box('troop-window-frame', dark, side * 1.285, 2.29, z, .027, .32, .69);
      box('troop-window-slit', glass, side * 1.302, 2.29, z, .018, .19, .55, root, false);
      for (const offset of [-.45, .45]) for (const y of [1.32, 2.51]) {
        box('armor-bolt', edge, side * 1.285, y, z + offset, .029, .045, .045, root, false);
      }
    }
    box('police-side-stripe', '#bbc8c4', side * 1.286, 1.92, -1.21, .023, .14, 3.25, root, false);
    box('unit-insignia', '#527a92', side * 1.302, 1.56, -1.20, .021, .31, .36, root, false);
    box('insignia-center', '#d4dfcf', side * 1.319, 1.56, -1.20, .014, .14, .14, root, false);
    for (const z of [-2.10, -.95, 2.13]) {
      box('wheel-arch-top', hull, side * 1.18, 1.16, z, .30, .17, 1.24);
      const steering = new THREE.Group(); steering.name = 'armored-steering-pivot';
      steering.position.set(side * 1.09, wheelRadius + .012, z);
      const wheel = new THREE.Group(); wheel.name = 'armored-wheel';
      const tire = part(wheel, 'cylinder', '#18272d', 0, 0, 0, wheelRadius, .34, wheelRadius);
      tire.name = 'run-flat-tire'; tire.rotation.z = Math.PI / 2;
      const rim = part(wheel, 'cylinder', edge, side * .178, 0, 0, .32, .024, .32);
      rim.name = 'armored-wheel-rim'; rim.rotation.z = Math.PI / 2;
      const hub = part(wheel, 'cylinder', dark, side * .194, 0, 0, .13, .025, .13);
      hub.name = 'armored-wheel-hub'; hub.rotation.z = Math.PI / 2;
      for (let lug = 0; lug < 6; lug++) {
        const angle = lug * Math.PI / 3;
        box('wheel-lug', '#a1b0af', side * .194, Math.cos(angle) * .235, Math.sin(angle) * .235, .025, .05, .05, wheel, false);
      }
      steering.add(wheel); root.add(steering); wheels.push(wheel);
      if (z > 2) frontWheels.push(steering);
    }
  }

  for (const side of [-1, 1]) {
    box('rear-egress-door', plate, side * .55, 1.87, -3.016, 1.035, 1.74, .065);
    box('rear-door-window-frame', dark, side * .55, 2.33, -3.056, .59, .36, .029);
    box('rear-door-window', glass, side * .55, 2.33, -3.075, .46, .23, .018, root, false);
    box('rear-door-lock-bar', edge, side * .17, 1.81, -3.07, .045, 1.22, .035);
    box('rear-door-handle', dark, side * .23, 1.67, -3.103, .15, .075, .045);
    for (const y of [1.32, 2.42]) box('rear-door-hinge', edge, side * 1.032, y, -3.059, .12, .085, .078);
  }
  box('troop-egress-step', edge, 0, .52, -3.01, 1.87, .105, .33);
  const hatch = part(root, 'cylinder', dark, 0, 2.98, -1.39, .60, .075, .60);
  hatch.name = 'roof-escape-hatch';
  box('hatch-handle', edge, 0, 3.05, -1.39, .25, .06, .065);
  for (const side of [-1, 1]) {
    rod('roof-handrail', edge, new THREE.Vector3(side * .86, 3.04, -2.53), new THREE.Vector3(side * .86, 3.04, -.31), .031);
    for (const z of [-2.53, -.31]) rod('rail-mount', edge, new THREE.Vector3(side * .86, 2.92, z), new THREE.Vector3(side * .86, 3.04, z), .03);
  }
  rod('radio-antenna', dark, new THREE.Vector3(-.88, 2.94, -2.67), new THREE.Vector3(-.88, 3.68, -2.79), .014, root, false);
  box('lightbar-base', dark, 0, 2.98, .60, 1.67, .13, .31);
  const leftLight = box('red-emergency-light', '#ff5157', .46, 3.07, .60, .66, .13, .28, root, false);
  const rightLight = box('blue-emergency-light', '#558cff', -.46, 3.07, .60, .66, .13, .28, root, false);
  return { root, wheels, frontWheels, wheelRadius, leftLight, rightLight };
}

/** Fuselage-center origin, +Z nose; animate mainRotor.y and tailRotor.x. */
export function createPoliceHelicopter(part: VehiclePart): PoliceHelicopterNode {
  const root = new THREE.Group(); root.name = 'police-helicopter';
  const { box, rod } = modelParts(root, part);
  const hull = '#283e4a', plate = '#3c5764', dark = '#16272e', glass = '#67919e', white = '#cbd7d0';
  const sphere = (name: string, color: string, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const mesh = part(root, 'sphere', color, x, y, z, sx, sy, sz); mesh.name = name; return mesh;
  };
  sphere('helicopter-fuselage', hull, 0, .04, -.15, 1.22, 1.13, 2.74);
  sphere('cockpit-glazing', glass, 0, .16, 1.50, 1.09, .91, 1.39);
  sphere('armored-nose', hull, 0, -.39, 1.84, 1.10, .53, 1.12);
  box('cockpit-roof', plate, 0, 1.03, 1.04, 1.53, .15, 1.54);
  // Curved seams follow the glazing rather than disappearing inside its volume.
  const screenPoint = (elevation: number, azimuth: number) => new THREE.Vector3(
    1.115 * Math.cos(elevation) * Math.sin(azimuth), .16 + .935 * Math.sin(elevation),
    1.50 + 1.415 * Math.cos(elevation) * Math.cos(azimuth));
  const screenElevations = [1.3, 1.05, .8, .55, .3, .05, -.18];
  for (const azimuth of [-.92, 0, .92]) {
    for (let index = 1; index < screenElevations.length; index++) {
      rod('windshield-curved-brace', hull, screenPoint(screenElevations[index - 1], azimuth), screenPoint(screenElevations[index], azimuth), .038);
    }
  }
  for (let index = 0; index < 10; index++) {
    rod('windshield-lower-frame', hull, screenPoint(-.18, -1.3 + index * .26), screenPoint(-.18, -1.3 + (index + 1) * .26), .039);
  }
  for (const side of [-1, 1]) {
    rod('cockpit-door-pillar', hull, new THREE.Vector3(side * .88, .92, .60), new THREE.Vector3(side * 1.13, -.34, .62), .057);
    box('cabin-door', plate, side * 1.08, -.09, -.71, .13, 1.47, 1.66);
    box('cabin-window-frame', dark, side * 1.154, .30, -.67, .047, .76, 1.38);
    box('cabin-window', glass, side * 1.183, .30, -.67, .018, .62, 1.23, root, false);
    box('sliding-door-track', '#6a818a', side * 1.171, -.77, -.70, .059, .06, 1.79);
    box('door-handle', white, side * 1.175, -.22, -.10, .06, .055, .24, root, false);
    box('police-fuselage-stripe', white, side * 1.177, -.46, -.70, .033, .13, 1.50, root, false);
    box('fuselage-unit-mark', '#679aba', side * 1.178, -.66, -.71, .032, .19, .25, root, false);
    sphere('engine-pod', plate, side * .56, 1.03, -.70, .45, .38, 1.07);
    const exhaust = part(root, 'cylinder', dark, side * .56, 1.04, -1.55, .23, .62, .23);
    exhaust.name = 'engine-exhaust'; exhaust.rotation.x = Math.PI / 2;
    box('engine-intake', dark, side * .56, 1.15, .155, .50, .22, .035);
    for (const z of [-.35, -.10, .15]) box('engine-intake-slat', '#7a8e95', side * .56, 1.355, z, .37, .022, .06, root, false);

    const skidX = side * 1.31;
    rod('landing-skid', dark, new THREE.Vector3(skidX, -1.22, -1.89), new THREE.Vector3(skidX, -1.22, 1.96), .07);
    rod('skid-curved-nose', dark, new THREE.Vector3(skidX, -1.22, 1.96), new THREE.Vector3(skidX, -1.02, 2.39), .07);
    for (const z of [-1.10, 1.05]) rod('skid-strut', plate, new THREE.Vector3(side * .72, -.57, z), new THREE.Vector3(skidX, -1.19, z), .074);
    box('boarding-step', plate, side * 1.26, -.96, -.39, .39, .064, .78);
  }

  const boom = part(root, 'cone', hull, 0, .32, -4.32, .57, 5.82, .57);
  boom.name = 'tapered-tail-boom'; boom.rotation.x = -Math.PI / 2;
  const fin = box('vertical-tail-fin', plate, 0, 1.07, -6.96, .14, 2.26, .92);
  fin.rotation.x = -.18;
  const finTip = box('tail-fin-tip', '#567fa0', 0, 2.02, -7.13, .17, .30, .76);
  finTip.rotation.x = -.18;
  box('horizontal-stabilizer', plate, 0, .37, -5.95, 3.32, .085, .64);
  for (const side of [-1, 1]) box('stabilizer-tip', white, side * 1.55, .37, -5.95, .23, .095, .65, root, false);
  for (const z of [-4.64, -4.91]) {
    const stripe = part(root, 'cylinder', white, 0, .32, z, .34 - (Math.abs(z) - 4.64) * .10, .105, .34 - (Math.abs(z) - 4.64) * .10, 0, false);
    stripe.name = 'tail-boom-band'; stripe.rotation.x = Math.PI / 2;
  }

  const mainRotor = new THREE.Group(); mainRotor.name = 'main-rotor'; mainRotor.position.set(0, 1.82, -.34); root.add(mainRotor);
  rod('main-rotor-mast', dark, new THREE.Vector3(0, 1.12, -.34), new THREE.Vector3(0, 2.01, -.34), .105);
  const hub = part(mainRotor, 'cylinder', '#899b9e', 0, 0, 0, .34, .18, .34); hub.name = 'main-rotor-hub';
  for (let index = 0; index < 4; index++) {
    const blade = new THREE.Group(); blade.name = 'main-rotor-blade'; blade.rotation.y = index * Math.PI / 2 + .10; mainRotor.add(blade);
    box('rotor-blade-root', '#83969b', 0, 0, .59, .14, .075, .78, blade);
    const airfoil = box('rotor-airfoil', dark, 0, .012, 3.09, .29, .049, 4.79, blade); airfoil.rotation.z = -.055;
    box('rotor-tip', white, 0, .012, 5.36, .30, .055, .26, blade, false);
  }
  const tailRotor = new THREE.Group(); tailRotor.name = 'tail-rotor'; tailRotor.position.set(.38, 1.06, -7.03); root.add(tailRotor);
  rod('tail-rotor-axle', '#83969b', new THREE.Vector3(-.13, 1.06, -7.03), new THREE.Vector3(.49, 1.06, -7.03), .105);
  for (let index = 0; index < 4; index++) {
    const blade = new THREE.Group(); blade.name = 'tail-rotor-blade'; blade.rotation.x = index * Math.PI / 2; tailRotor.add(blade);
    box('tail-rotor-airfoil', dark, 0, .56, 0, .065, .97, .16, blade);
    box('tail-rotor-tip', white, 0, .98, 0, .073, .16, .17, blade, false);
  }

  sphere('chin-turret', plate, 0, -.91, 1.68, .31, .30, .36);
  const gun = new THREE.Group(); gun.name = 'helicopter-gun'; gun.position.set(0, -1.1, 1.7); root.add(gun);
  box('gun-receiver', dark, 0, 0, .21, .23, .21, .48, gun);
  rod('gun-barrel', '#4e646c', new THREE.Vector3(0, 0, .38), new THREE.Vector3(0, 0, 1.33), .066, gun);
  rod('gun-muzzle-brake', dark, new THREE.Vector3(0, 0, 1.21), new THREE.Vector3(0, 0, 1.40), .099, gun);
  const muzzle = new THREE.Group(); muzzle.name = 'helicopter-muzzle'; muzzle.position.set(0, 0, 1.4); gun.add(muzzle);
  sphere('searchlight-housing', dark, -.58, -.83, 1.89, .25, .22, .26);
  const searchlight = part(root, 'cylinder', '#f1edc6', -.58, -.88, 2.104, .17, .025, .17, 0, false);
  searchlight.name = 'searchlight-lens'; searchlight.rotation.x = Math.PI / 2;
  sphere('red-navigation-light', '#ed5f5b', 1.235, .38, -.75, .065, .06, .075);
  sphere('blue-navigation-light', '#5f9aff', -1.235, .38, -.75, .065, .06, .075);
  rod('helicopter-radio-antenna', dark, new THREE.Vector3(0, 1.10, -1.89), new THREE.Vector3(0, 1.74, -2.25), .016, root, false);
  return { root, mainRotor, tailRotor, gun, muzzle };
}
