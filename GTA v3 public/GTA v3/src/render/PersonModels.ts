import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type PersonRole = 'player' | 'pedestrian' | 'officer';
export type PersonSide = 'left' | 'right';
export const PERSON_SOLE_BOUNDS = { minY: -.51, maxY: -.46, minZ: -.153, maxZ: .277 } as const;
export interface PersonModelOptions { id: string; shirt: string; role: PersonRole }
export interface PersonModel {
  root: THREE.Group; body: THREE.Group; head: THREE.Group;
  leftArm: THREE.Group; rightArm: THREE.Group;
  leftForearm: THREE.Group; rightForearm: THREE.Group;
  leftHand: THREE.Group; rightHand: THREE.Group;
  leftLeg: THREE.Group; rightLeg: THREE.Group;
  leftShin: THREE.Group; rightShin: THREE.Group;
  skin: string; shirt: string;
}

type Primitive = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torso' | 'head' | 'scalp';
type Hat = 'none' | 'cap' | 'beanie' | 'bucket';
type Hairstyle = 'crop' | 'side-part' | 'curls' | 'swept' | 'bob' | 'tied-back';
interface Appearance {
  variant: number; skin: string; shirt: string; hair: string; eye: string;
  hairstyle: Hairstyle; hat: Hat; hatColor: string; trousers: string; shoes: string;
  outfit: number; glasses: boolean; beard: boolean; watch: boolean;
}

const SKINS = ['#c99773', '#e2b798', '#b88061', '#956649', '#754e3d', '#d5a17e'];
const HAIR = ['#354044', '#514238', '#805d43', '#b79a6a', '#a56f4c', '#a8a8a0'];
const SHIRTS = ['#ee9973', '#7d9cae', '#edcb73', '#9bbb99', '#c9a2b6', '#3f6974', '#c7c4b5', '#597c88'];
const TROUSERS = ['#405763', '#565951', '#6c655b', '#415d60'];
const SHOES = ['#e5d9c3', '#485558', '#ae8270', '#778f8d'];
const HAT_COLORS = ['#738f87', '#d49b74', '#597a90', '#c8b780', '#8a778a', '#52615b'];
const HAIRSTYLES: Hairstyle[] = ['crop', 'side-part', 'curls', 'swept', 'bob', 'tied-back'];
const HATS: Hat[] = ['none', 'none', 'none', 'cap', 'beanie', 'bucket'];
const EYES = ['#574a3d', '#53776e', '#577589', '#756047'];

/** IDs, including long-lived replacement patrol IDs, map into 24 finite appearances. */
function hashId(id: string): number {
  let value = 2166136261;
  for (let i = 0; i < id.length; i++) value = Math.imul(value ^ id.charCodeAt(i), 16777619);
  value ^= value >>> 16;
  return value >>> 0;
}

function nearestColor(value: string, palette: readonly string[]): string {
  const parsed = new THREE.Color(/^#[\da-f]{6}$/i.test(value) ? value : palette[0]);
  let best = palette[0], distance = Infinity;
  for (const color of palette) {
    const candidate = new THREE.Color(color);
    const next = (parsed.r - candidate.r) ** 2 + (parsed.g - candidate.g) ** 2 + (parsed.b - candidate.b) ** 2;
    if (next < distance) { best = color; distance = next; }
  }
  return best;
}

function shade(value: string, amount: number): string {
  return `#${new THREE.Color(value).lerp(new THREE.Color(amount > 0 ? '#fff6e6' : '#2b2526'), Math.abs(amount)).getHexString()}`;
}

function appearanceFor(options: PersonModelOptions): Appearance {
  const variant = options.role === 'player' ? 0 : hashId(options.id) % 24;
  const skin = options.role === 'player' ? SKINS[0] : SKINS[(variant + Math.floor(variant / 6)) % SKINS.length];
  return {
    variant, skin,
    shirt: options.role === 'player' ? '#eee4cb' : options.role === 'officer' ? '#314b61' : nearestColor(options.shirt, SHIRTS),
    hair: options.role === 'player' ? HAIR[0] : HAIR[(variant * 5 + Math.floor(variant / 4)) % HAIR.length],
    eye: EYES[variant % EYES.length],
    hairstyle: options.role === 'player' ? 'side-part' : HAIRSTYLES[(variant * 5 + Math.floor(variant / 6)) % HAIRSTYLES.length],
    hat: options.role === 'player' ? 'none' : options.role === 'officer' ? 'cap' : HATS[variant % HATS.length],
    hatColor: options.role === 'officer' ? '#30485b' : HAT_COLORS[(variant + 2) % HAT_COLORS.length],
    trousers: options.role === 'player' ? '#354f62' : options.role === 'officer' ? '#293e52' : TROUSERS[variant % TROUSERS.length],
    shoes: options.role === 'player' ? '#f1e4cb' : options.role === 'officer' ? '#29383e' : SHOES[(variant + 1) % SHOES.length],
    outfit: options.role === 'pedestrian' ? (variant + Math.floor(variant / 5)) % 4 : 0,
    glasses: options.role === 'pedestrian' && variant % 7 === 4,
    beard: options.role !== 'player' && variant % 8 === 3,
    watch: options.role === 'player' || variant % 3 === 1,
  };
}

/** Faceted rings keep cheeks broad and give the head a real jaw and chin. */
function headGeometry(): THREE.BufferGeometry {
  const rings = [
    [-.226, .105, .11, .012], [-.174, .174, .153, .005],
    [-.045, .226, .192, 0], [.105, .221, .197, -.005],
    [.215, .149, .144, -.008], [.242, .062, .066, -.01],
  ];
  const positions: number[] = [], indices: number[] = [];
  const sides = 12;
  for (const [y, rx, rz, cz] of rings) for (let side = 0; side < sides; side++) {
    const angle = side / sides * Math.PI * 2;
    positions.push(Math.sin(angle) * rx, y, Math.cos(angle) * rz + cz);
  }
  for (let ring = 0; ring < rings.length - 1; ring++) for (let side = 0; side < sides; side++) {
    const a = ring * sides + side, b = ring * sides + (side + 1) % sides;
    indices.push(a, b, b + sides, a, b + sides, a + sides);
  }
  const bottom = positions.length / 3;
  positions.push(0, rings[0][0], rings[0][3]);
  const top = positions.length / 3;
  positions.push(0, rings[rings.length - 1][0], rings[rings.length - 1][3]);
  for (let side = 0; side < sides; side++) {
    indices.push(bottom, (side + 1) % sides, side);
    const last = (rings.length - 1) * sides;
    indices.push(top, last + side, last + (side + 1) % sides);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** All the small details below become one vertex-colored mesh for their joint. */
class RigidParts {
  private readonly parts: THREE.BufferGeometry[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly rotation = new THREE.Quaternion();
  constructor(private readonly shapes: Record<Primitive, THREE.BufferGeometry>) {}

  add(shape: Primitive, color: string, x: number, y: number, z: number,
    sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0): void {
    const geometry = this.shapes[shape].clone();
    this.rotation.setFromEuler(new THREE.Euler(rx, ry, rz));
    this.matrix.compose(new THREE.Vector3(x, y, z), this.rotation, new THREE.Vector3(sx, sy, sz));
    geometry.applyMatrix4(this.matrix);
    const rgb = new THREE.Color(color);
    const colors = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) { colors[i] = rgb.r; colors[i + 1] = rgb.g; colors[i + 2] = rgb.b; }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.parts.push(geometry);
  }

  finish(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    for (const part of this.parts) part.dispose();
    if (!merged) throw new Error('Person rigid geometry could not be merged');
    merged.computeBoundingBox(); merged.computeBoundingSphere();
    return merged;
  }
}

/**
 * +Z is forward; anatomical right is -X. Feet sit at zero in the neutral pose.
 * A factory owns its finite geometry cache and one material. Instances only own
 * transforms; remove all instances before disposing the factory.
 */
export class PersonModelFactory {
  private readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .94, metalness: 0, flatShading: true });
  private readonly cache = new Map<string, THREE.BufferGeometry>();
  private readonly shapes: Record<Primitive, THREE.BufferGeometry>;
  private disposed = false;

  constructor() {
    const torso = new THREE.BoxGeometry(1, 1, 1);
    const vertices = torso.getAttribute('position');
    for (let i = 0; i < vertices.count; i++) if (vertices.getY(i) < 0) {
      vertices.setX(i, vertices.getX(i) * .84);
      vertices.setZ(i, vertices.getZ(i) * .92);
    }
    torso.computeVertexNormals();
    this.shapes = {
      box: new THREE.BoxGeometry(1, 1, 1), sphere: new THREE.SphereGeometry(1, 10, 7),
      cylinder: new THREE.CylinderGeometry(1, 1, 1, 12), cone: new THREE.ConeGeometry(1, 1, 10),
      scalp: new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI * .53), torso, head: headGeometry(),
    };
    for (const shape of Object.values(this.shapes)) shape.deleteAttribute('uv');
    this.material.name = 'person-shared-vertex-colors';
  }

  private joint(name: string, key: string, build: (parts: RigidParts) => void): THREE.Group {
    if (this.disposed) throw new Error('Cannot create a person after disposing its factory');
    let geometry = this.cache.get(key);
    if (!geometry) {
      const parts = new RigidParts(this.shapes); build(parts); geometry = parts.finish();
      geometry.name = `person-${key}`;
      this.cache.set(key, geometry);
    }
    const group = new THREE.Group(); group.name = name;
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = `${name}-surface`; mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    return group;
  }

  create(options: PersonModelOptions): PersonModel {
    const appearance = appearanceFor(options), a = appearance;
    const root = new THREE.Group(); root.name = `person-${options.role}-${options.id}`;
    root.userData.appearance = { ...appearance, role: options.role };
    const body = this.joint('body', `body:${options.role}:${a.shirt}:${a.skin}:${a.outfit}:${a.trousers}`, p => this.torso(p, a, options.role));
    root.add(body);
    const head = this.joint('head', `head:${options.role}:${a.variant}`, p => this.face(p, a, options.role));
    head.position.set(0, 1.95, 0); body.add(head);
    const arms = (side: PersonSide) => {
      const sign = side === 'right' ? -1 : 1;
      const arm = this.joint(`${side}-arm`, `arm:${options.role}:${a.shirt}:${a.skin}:${a.outfit}:${side}`, p => this.upperArm(p, a, options.role));
      arm.position.set(sign * .4, 1.54, 0); body.add(arm);
      const watch = a.watch && side === 'left';
      const forearm = this.joint(`${side}-forearm`, `forearm:${a.skin}:${watch}`, p => {
        p.add('sphere', a.skin, 0, -.014, 0, .078, .083, .081);
        p.add('torso', a.skin, 0, -.133, 0, .145, .248, .155);
        p.add('sphere', a.skin, 0, -.24, 0, .062, .04, .071);
        if (watch) {
          p.add('box', '#425257', 0, -.219, 0, .145, .041, .162);
          p.add('box', '#c7cec1', 0, -.217, -.092, .077, .046, .024);
          p.add('box', '#385b66', 0, -.216, -.108, .055, .03, .009);
        }
      });
      forearm.position.y = -.30; arm.add(forearm);
      const hand = this.createHand(a.skin, side);
      hand.position.y = -.27; forearm.add(hand);
      return { arm, forearm, hand };
    };
    const legs = (side: PersonSide) => {
      const sign = side === 'right' ? -1 : 1;
      const leg = this.joint(`${side}-leg`, `thigh:${a.trousers}:${side}`, p => {
        p.add('torso', a.trousers, 0, -.182, 0, .253, .394, .286);
        p.add('box', shade(a.trousers, -.12), sign * .113, -.10, .074, .015, .12, .071);
      });
      leg.position.set(sign * .165, .91, 0); body.add(leg);
      const shin = this.joint(`${side}-shin`, `shin:${a.trousers}:${a.shoes}:${options.role === 'officer'}`, p => {
        p.add('sphere', a.trousers, 0, -.012, 0, .114, .085, .13);
        p.add('torso', a.trousers, 0, -.19, 0, .224, .368, .267);
        p.add('box', shade(a.trousers, -.13), 0, -.358, .002, .229, .035, .276);
        p.add('box', a.shoes, 0, -.433, .063, .271, .11, .405);
        p.add('sphere', a.shoes, 0, -.427, .153, .132, .057, .121);
        const sole = PERSON_SOLE_BOUNDS;
        p.add('box', options.role === 'officer' ? '#526066' : '#e5dfd0', 0, (sole.minY + sole.maxY) / 2,
          (sole.minZ + sole.maxZ) / 2, .284, sole.maxY - sole.minY, sole.maxZ - sole.minZ);
        p.add('box', shade(a.shoes, -.22), 0, -.427, -.131, .254, .09, .035);
        for (const z of [.026, .061, .096]) p.add('box', options.role === 'officer' ? '#718086' : '#f5efdf', 0, -.375, z, .132, .012, .013);
      });
      shin.position.y = -.40; leg.add(shin);
      return { leg, shin };
    };
    const left = arms('left'), right = arms('right'), leftLeg = legs('left'), rightLeg = legs('right');
    return { root, body, head, leftArm: left.arm, rightArm: right.arm, leftForearm: left.forearm, rightForearm: right.forearm,
      leftHand: left.hand, rightHand: right.hand, leftLeg: leftLeg.leg, rightLeg: rightLeg.leg,
      leftShin: leftLeg.shin, rightShin: rightLeg.shin, skin: a.skin, shirt: a.shirt };
  }

  /** Palm-center origin. Relaxed fingers point -Y; gripping fingers wrap a Y-axis handle. */
  createHand(skin: string, side: PersonSide, grip = false): THREE.Group {
    const tone = nearestColor(skin, SKINS), thumb = side === 'right' ? 1 : -1;
    const hand = this.joint(`${side}-${grip ? 'gripping-' : ''}hand`, `hand:${tone}:${side}:${grip}`, p => {
      if (grip) {
        const palmSide = -thumb;
        p.add('box', tone, palmSide * .064, -.003, -.01, .059, .13, .139);
        p.add('sphere', tone, palmSide * .063, .041, -.006, .033, .043, .07);
        for (const y of [-.045, -.015, .015, .045]) {
          p.add('box', tone, palmSide * .022, y, .067, .085, .026, .035);
          p.add('box', shade(tone, -.045), -palmSide * .031, y, .044, .033, .026, .067);
          p.add('sphere', tone, -palmSide * .031, y, .009, .017, .013, .014);
        }
        p.add('box', tone, .006 * thumb, .061, -.061, .102, .035, .03, 0, 0, -.28 * thumb);
      } else {
        p.add('box', tone, 0, -.002, 0, .12, .125, .074);
        p.add('sphere', tone, 0, .034, 0, .061, .04, .038);
        const fingers = [[-.044, .077], [-.014, .102], [.016, .096], [.045, .074]];
        for (const [x, length] of fingers) {
          p.add('box', tone, x, -.058 - length / 2, .003, .026, length, .061);
          p.add('sphere', tone, x, -.058 - length, .003, .013, .013, .03);
          p.add('box', shade(tone, .18), x, -.047 - length, -.029, .017, .023, .006);
        }
        p.add('box', tone, thumb * .077, -.029, .014, .036, .092, .047, 0, 0, -.35 * thumb);
        p.add('sphere', tone, thumb * .092, -.067, .014, .018, .025, .024);
      }
    });
    hand.userData.grip = grip; hand.userData.side = side;
    return hand;
  }

  private torso(p: RigidParts, a: Appearance, role: PersonRole): void {
    const light = shade(a.shirt, .12), seam = shade(a.shirt, -.17);
    p.add('torso', a.shirt, 0, 1.275, 0, .624, .67, .373);
    p.add('box', a.trousers, 0, .932, 0, .525, .094, .342);
    p.add('cylinder', a.skin, 0, 1.69, -.003, .092, .173, .091);
    p.add('cylinder', seam, 0, 1.611, -.006, .124, .03, .116);
    p.add('cylinder', a.skin, 0, 1.632, -.006, .091, .032, .088);
    p.add('box', seam, 0, .97, .004, .535, .037, .35);
    if (role === 'officer') {
      for (const sign of [-1, 1]) {
        p.add('box', light, sign * .105, 1.567, .187, .095, .09, .038, 0, 0, sign * .37);
        p.add('box', seam, sign * .165, 1.357, .192, .14, .151, .021);
        p.add('box', light, sign * .165, 1.431, .209, .151, .03, .026);
        p.add('box', '#8197a0', sign * .235, 1.618, -.001, .123, .028, .259);
      }
      p.add('box', '#233b4c', 0, 1.311, .197, .023, .53, .018);
      for (const y of [1.54, 1.43, 1.31, 1.19]) p.add('sphere', '#aab7b7', 0, y, .216, .012, .012, .008);
      p.add('sphere', '#e0c787', -.16, 1.458, .24, .046, .057, .013);
      p.add('box', '#fff0b4', -.16, 1.477, .255, .028, .028, .009);
      p.add('box', '#192f3d', .208, 1.438, .228, .072, .127, .06);
      p.add('box', '#263e4b', .228, 1.534, .229, .014, .089, .018);
      for (const y of [1.418, 1.437, 1.456]) p.add('box', '#8c9c9c', .208, y, .262, .045, .006, .007);
      p.add('box', '#29373f', 0, .965, 0, .571, .082, .387);
      p.add('box', '#c2be9e', 0, .967, .212, .072, .056, .034);
      for (const sign of [-1, 1]) p.add('box', '#263640', sign * .247, .986, .14, .104, .141, .099);
    } else if (role === 'player') {
      for (const sign of [-1, 1]) {
        p.add('box', light, sign * .097, 1.571, .188, .095, .102, .045, 0, 0, sign * .38);
        p.add('box', '#3b817e', sign * .193, 1.332, .192, .059, .525, .043, 0, 0, -sign * .025);
        p.add('box', '#5da09a', sign * .212, 1.603, -.028, .06, .03, .38, .1);
        p.add('box', '#d9c594', sign * .193, 1.191, .22, .073, .035, .025);
      }
      p.add('box', '#297c79', 0, 1.285, -.258, .435, .537, .17);
      p.add('torso', '#39918b', 0, 1.306, -.304, .401, .463, .154);
      p.add('box', '#327f7d', 0, 1.197, -.405, .305, .187, .069);
      p.add('box', '#dabe7d', 0, 1.287, -.443, .298, .021, .012);
      p.add('box', '#f1d48d', .11, 1.261, -.455, .021, .042, .011);
      p.add('box', '#e8c883', 0, 1.207, -.448, .087, .05, .01);
      p.add('box', '#245d5c', 0, 1.574, -.303, .153, .06, .051);
    } else {
      if (a.outfit === 0) {
        p.add('box', light, -.162, 1.384, .196, .139, .149, .026);
        p.add('box', seam, -.162, 1.456, .214, .142, .017, .012);
      } else if (a.outfit === 1) {
        p.add('box', '#e5dcc5', 0, 1.342, .194, .167, .474, .023);
        for (const sign of [-1, 1]) {
          p.add('box', light, sign * .096, 1.573, .204, .103, .108, .04, 0, 0, sign * .32);
          p.add('box', seam, sign * .104, 1.294, .211, .023, .496, .023);
          p.add('box', light, sign * .206, 1.39, .197, .115, .144, .023);
        }
        for (const y of [1.473, 1.35, 1.227, 1.104]) p.add('sphere', '#e9d9b5', -.106, y, .23, .012, .012, .008);
      } else if (a.outfit === 2) {
        for (const y of [1.292, 1.324, 1.356]) p.add('box', '#e5dbc1', 0, y, .194, .569, .014, .016);
        p.add('box', seam, 0, 1.002, 0, .552, .05, .364);
      } else {
        p.add('box', seam, 0, 1.294, .194, .025, .572, .027);
        p.add('box', '#d2c7a9', .009, 1.504, .218, .023, .039, .015);
        for (const sign of [-1, 1]) {
          p.add('box', light, sign * .092, 1.58, .135, .129, .1, .152, 0, 0, sign * .29);
          p.add('box', seam, sign * .187, 1.146, .191, .102, .018, .02, 0, 0, sign * .45);
        }
      }
    }
  }

  private upperArm(p: RigidParts, a: Appearance, role: PersonRole): void {
    p.add('sphere', a.shirt, 0, -.065, 0, .118, .111, .133);
    p.add('torso', a.shirt, 0, -.136, 0, .225, .238, .25);
    p.add('box', shade(a.shirt, -.11), 0, -.232, 0, .213, .029, .252);
    p.add('box', a.skin, 0, -.275, 0, .15, .077, .172);
    if (role === 'officer') {
      p.add('box', '#6e8c9e', 0, -.127, -.132, .09, .101, .024);
      p.add('box', '#d6c487', 0, -.128, -.148, .054, .058, .012);
    }
  }

  private face(p: RigidParts, a: Appearance, role: PersonRole): void {
    const shadow = shade(a.skin, -.19), lip = shade(a.skin, -.29);
    p.add('head', a.skin, 0, 0, 0, 1, 1, 1);
    p.add('sphere', a.skin, 0, -.183, .037, .111, .06, .132);
    for (const sign of [-1, 1]) {
      p.add('sphere', a.skin, sign * .226, -.024, -.012, .042, .068, .039);
      p.add('sphere', shadow, sign * .248, -.024, .015, .015, .039, .019);
      p.add('sphere', a.skin, sign * .236, -.074, -.003, .025, .025, .029);
      p.add('box', '#f4f0e2', sign * .088, .042, .193, .087, .052, .028, 0, sign * .075);
      p.add('sphere', a.eye, sign * .085, .04, .211, .024, .026, .011);
      p.add('sphere', '#283638', sign * .085, .04, .222, .012, .02, .007);
      p.add('sphere', '#fff9e9', sign * .085 - .005, .049, .229, .0047, .0055, .003);
      p.add('box', shadow, sign * .088, .071, .2, .097, .012, .022, 0, sign * .07);
      p.add('box', a.hair, sign * .09, .112, .19, .103, .022, .029, 0, sign * .08, sign * .06);
    }
    p.add('box', a.skin, 0, .007, .216, .045, .105, .06);
    p.add('sphere', shade(a.skin, .055), 0, -.04, .255, .047, .038, .042);
    for (const sign of [-1, 1]) p.add('sphere', shadow, sign * .026, -.064, .266, .009, .006, .009);
    p.add('box', lip, 0, -.116, .18, .106, .016, .018);
    p.add('box', shade(a.skin, .075), 0, -.134, .177, .075, .014, .019);
    for (const sign of [-1, 1]) p.add('sphere', shadow, sign * .057, -.115, .179, .009, .011, .008);
    if (a.beard) {
      p.add('sphere', a.hair, 0, -.197, .069, .119, .052, .106);
      for (const sign of [-1, 1]) {
        p.add('box', a.hair, sign * .159, -.118, .061, .035, .122, .089, 0, 0, -sign * .27);
        p.add('box', a.hair, sign * .036, -.084, .192, .073, .023, .016, 0, 0, sign * .06);
      }
    }
    this.hair(p, a);
    if (a.hat !== 'none') this.hat(p, a, role);
    if (a.glasses) {
      const frame = '#43575a';
      for (const sign of [-1, 1]) {
        for (const y of [.005, .08]) p.add('box', frame, sign * .09, y, .236, .119, .011, .013);
        for (const x of [sign * .034, sign * .146]) p.add('box', frame, x, .042, .234, .011, .076, .014);
        p.add('box', frame, sign * .203, .06, .113, .015, .015, .206, 0, -sign * .44);
      }
      p.add('box', frame, 0, .055, .239, .06, .01, .014);
    }
  }

  private hair(p: RigidParts, a: Appearance): void {
    const dark = shade(a.hair, -.12), light = shade(a.hair, .085);
    p.add('scalp', a.hair, 0, .062, -.01, .235, .216, .213);
    for (const sign of [-1, 1]) p.add('box', dark, sign * .208, .043, -.043, .041, .157, .182);
    if (a.hat !== 'none') {
      p.add('box', a.hair, 0, -.007, -.184, .337, .18, .04);
      return;
    }
    if (a.hairstyle === 'crop') {
      for (let i = 0; i < 5; i++) p.add('box', i % 2 ? light : a.hair, (i - 2) * .073, .133, .169, .083, .066, .067, -.1, 0, (i - 2) * -.018);
    } else if (a.hairstyle === 'side-part') {
      // Overlapping faceted locks grow from the scalp; the narrow dark valley
      // between the swept top and the short side reads as a side part.
      p.add('sphere', a.hair, -.07, .171, -.013, .18, .112, .196, .06, -.08, -.08);
      p.add('sphere', a.hair, -.089, .203, .113, .158, .061, .108, -.1, -.09, -.1);
      p.add('sphere', light, -.111, .225, .056, .129, .039, .126, -.12, -.12, -.1);
      p.add('sphere', dark, .083, .181, .063, .024, .083, .127, -.15, -.05, -.1);
      p.add('sphere', a.hair, .155, .152, .026, .074, .112, .176, .04, .03, .12);
    } else if (a.hairstyle === 'curls') {
      for (let i = 0; i < 10; i++) {
        const angle = i / 10 * Math.PI * 2;
        p.add('sphere', i % 3 ? a.hair : light, Math.sin(angle) * .18, .17 + (i % 2) * .025, Math.cos(angle) * .166 - .017, .08, .084, .076);
      }
      for (const x of [-.09, .025, .116]) p.add('sphere', a.hair, x, .252, -.012, .087, .068, .126);
    } else if (a.hairstyle === 'swept') {
      for (let i = 0; i < 4; i++) p.add('box', i % 2 ? light : a.hair, -.128 + i * .081, .227 - Math.abs(i - 1.5) * .015, .025, .104, .137, .257, -.21, .075, -.23);
      p.add('box', dark, -.114, .133, .153, .134, .093, .104, -.14, 0, -.2);
    } else if (a.hairstyle === 'bob') {
      p.add('box', a.hair, 0, -.024, -.181, .4, .327, .105);
      for (const sign of [-1, 1]) {
        p.add('box', a.hair, sign * .218, -.052, -.034, .072, .365, .278, 0, 0, sign * .07);
        p.add('box', light, sign * .254, -.053, -.029, .012, .29, .142, 0, 0, sign * .07);
        p.add('box', dark, sign * .133, .144, .143, .093, .122, .105, 0, 0, sign * .22);
      }
    } else {
      p.add('sphere', a.hair, 0, .044, -.232, .091, .092, .086);
      p.add('box', '#acbca5', 0, -.012, -.247, .094, .028, .063);
      p.add('sphere', a.hair, 0, -.103, -.271, .069, .123, .066);
      for (const sign of [-1, 1]) p.add('box', light, sign * .126, .192, .107, .097, .085, .181, 0, sign * .1, sign * .23);
    }
  }

  private hat(p: RigidParts, a: Appearance, role: PersonRole): void {
    const color = a.hatColor, dark = shade(color, -.15), light = shade(color, .13);
    if (a.hat === 'cap') {
      p.add('scalp', color, 0, .159, -.016, .259, .183, .244);
      p.add('cylinder', dark, 0, .158, -.019, .254, .052, .236);
      p.add('box', dark, 0, .142, .254, .397, .031, .245, -.07);
      p.add('sphere', color, 0, .143, .351, .194, .017, .071);
      p.add('sphere', light, 0, .342, -.016, .027, .018, .027);
      if (role === 'officer') {
        p.add('box', '#c5b585', 0, .172, .224, .391, .018, .019);
        p.add('sphere', '#e3cc86', 0, .247, .218, .04, .049, .016);
        p.add('box', '#fff0b4', 0, .255, .236, .029, .027, .008);
      } else p.add('box', '#e6ddbb', 0, .242, .222, .085, .058, .02);
    } else if (a.hat === 'beanie') {
      p.add('scalp', color, 0, .126, -.015, .259, .249, .239);
      p.add('cylinder', dark, 0, .116, -.014, .254, .089, .235);
      for (let i = 0; i < 16; i++) {
        const angle = i / 16 * Math.PI * 2;
        p.add('box', light, Math.sin(angle) * .252, .118, Math.cos(angle) * .233 - .014, .011, .068, .012, 0, angle);
      }
      p.add('box', '#e5d9b8', -.086, .114, .216, .067, .048, .023);
    } else {
      p.add('cylinder', color, 0, .234, -.018, .236, .204, .222);
      p.add('cylinder', light, 0, .132, -.018, .319, .038, .304);
      p.add('cylinder', color, 0, .146, -.018, .283, .027, .27);
      p.add('cylinder', dark, 0, .186, -.018, .24, .029, .226);
      p.add('box', '#e9ddbc', -.078, .252, .207, .066, .043, .014);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this.cache.values()) geometry.dispose();
    this.cache.clear();
    for (const geometry of Object.values(this.shapes)) geometry.dispose();
    this.material.dispose();
  }
}
