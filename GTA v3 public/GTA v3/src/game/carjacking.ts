import { angleDelta, boxIntersects, circleIntersectsBox, clamp, dist } from './collision';
import { getVehicleAccess } from './vehicleAccess';
import type { CarjackingPhase, CarjackingState, GameState, Point, Point3, Vehicle, World } from './types';

export const CARJACKING_TIMING = { open: .35, pull: .8, fall: .35, enter: .85, close: .35, recover: 1.1 } as const;
const APPROACH_SPEED = 3.4;
const WALK_RADIUS = .48;
const VEHICLE_ROOT_Y = .12;

export interface CarjackingPose extends Point3 { yaw: number; pitch: number; roll: number }
export interface CarjackingSample {
  phase: CarjackingPhase; progress: number; doorOpen: number;
  player: CarjackingPose; driver: CarjackingPose; seatEye: Point3;
  playerSeated: number; driverSeated: number; driverVisible: boolean;
}

const smooth = (value: number): number => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const mixYaw = (a: number, b: number, t: number): number => a + angleDelta(a, b) * t;
const mixPoint = (a: Point3, b: Point3, t: number): Point3 => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), z: mix(a.z, b.z, t) });
const pose = (point: Point3, yaw: number, pitch = 0, roll = 0): CarjackingPose => ({ ...point, yaw, pitch, roll });

export function carjackingReleaseTime(sequence: CarjackingState): number {
  return sequence.approachDuration + CARJACKING_TIMING.open + CARJACKING_TIMING.pull;
}

function phaseAt(sequence: CarjackingState): { phase: CarjackingPhase; progress: number } {
  let elapsed = clamp(sequence.elapsed, 0, sequence.duration);
  const phases: [CarjackingPhase, number][] = [['approach', sequence.approachDuration], ['open', CARJACKING_TIMING.open],
    ['pull', CARJACKING_TIMING.pull], ['fall', CARJACKING_TIMING.fall], ['enter', CARJACKING_TIMING.enter], ['close', CARJACKING_TIMING.close]];
  for (const [phase, duration] of phases) {
    if (elapsed < duration || phase === 'close') return { phase, progress: clamp(elapsed / duration, 0, 1) };
    elapsed -= duration;
  }
  return { phase: 'close', progress: 1 };
}

function pathLength(points: Point[]): number {
  return points.reduce((sum, point, index) => sum + (index ? dist(points[index - 1], point) : 0), 0);
}

function alongPath(points: Point[], amount: number): { point: Point; yaw: number } {
  let remaining = pathLength(points) * clamp(amount, 0, 1);
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index], length = dist(a, b);
    if (remaining <= length || index === points.length - 1) {
      const t = length ? clamp(remaining / length, 0, 1) : 1;
      return { point: { x: mix(a.x, b.x, t), z: mix(a.z, b.z, t) }, yaw: Math.atan2(b.x - a.x, b.z - a.z) };
    }
    remaining -= length;
  }
  return { point: points[0], yaw: 0 };
}

/** A pure timeline shared by both camera perspectives and the world actors. */
export function sampleCarjacking(sequence: CarjackingState): CarjackingSample {
  const { phase, progress } = phaseAt(sequence);
  const t = smooth(progress), facingDoor = sequence.carYaw - Math.PI / 2;
  const reachLean = clamp(.30 + (1.73 - sequence.seatEye.y) * .25, .30, .37);
  let player = pose(sequence.staging, facingDoor);
  let playerSeated = 0;
  if (phase === 'approach') {
    const sample = alongPath(sequence.approachPath, progress);
    const movingYaw = mixYaw(sequence.startYaw, sample.yaw, smooth(sequence.elapsed / .18));
    player = pose({ ...sample.point, y: 0 }, mixYaw(movingYaw, facingDoor, smooth((progress - .82) / .18)));
  } else if (phase === 'open') {
    player = pose(mixPoint(sequence.staging, sequence.reach, t), facingDoor, reachLean * t);
  } else if (phase === 'pull') {
    player = pose(mixPoint(sequence.reach, sequence.playerPull, t), facingDoor, reachLean * (1 - t) + Math.sin(progress * Math.PI) * .16);
  } else if (phase === 'fall') {
    player = pose(sequence.playerPull, facingDoor);
  } else if (phase === 'enter') {
    const a = progress < .36 ? sequence.playerPull : progress < .66 ? sequence.reach : sequence.door;
    const b = progress < .36 ? sequence.reach : progress < .66 ? sequence.door : sequence.seat;
    const local = progress < .36 ? progress / .36 : progress < .66 ? (progress - .36) / .30 : (progress - .66) / .34;
    playerSeated = smooth((progress - .30) / .70);
    player = pose(mixPoint(a, b, smooth(local)), mixYaw(facingDoor, sequence.carYaw, playerSeated), Math.sin(progress * Math.PI) * .23);
  } else {
    playerSeated = 1; player = pose(sequence.seat, sequence.carYaw);
  }

  let driver = pose(sequence.seat, sequence.carYaw), driverSeated = 1;
  if (phase === 'pull') {
    driverSeated = 1 - t;
    driver = pose(mixPoint(sequence.seat, sequence.driverOut, t), mixYaw(sequence.carYaw, sequence.carYaw + Math.PI / 2, t), Math.sin(progress * Math.PI) * .34);
  } else if (phase === 'fall') {
    driverSeated = 0;
    const forwardDistance = (sequence.ejection.x - sequence.driverOut.x) * Math.sin(sequence.carYaw) +
      (sequence.ejection.z - sequence.driverOut.z) * Math.cos(sequence.carYaw);
    const clearDoor = { x: sequence.ejection.x - Math.sin(sequence.carYaw) * forwardDistance,
      y: 0, z: sequence.ejection.z - Math.cos(sequence.carYaw) * forwardDistance };
    // Clear the open panel outboard before the falling body fans toward its landing.
    const position = progress < .55 ? mixPoint(sequence.driverOut, clearDoor, smooth(progress / .55)) :
      mixPoint(clearDoor, sequence.ejection, smooth((progress - .55) / .45));
    position.y += Math.sin(progress * Math.PI) * .10;
    driver = pose(position, sequence.carYaw + Math.PI / 2, t * Math.PI / 2, Math.sin(progress * Math.PI) * .08);
  } else if (phase === 'enter' || phase === 'close') {
    driverSeated = 0;
    driver = pose(sequence.ejection, sequence.carYaw + Math.PI / 2, Math.PI / 2);
  }
  if (phase === 'pull') player.yaw = mixYaw(facingDoor, Math.atan2(driver.x - player.x, driver.z - player.z), smooth(progress / .15));
  if (phase === 'fall') player.yaw = mixYaw(Math.atan2(sequence.driverOut.x - sequence.playerPull.x,
    sequence.driverOut.z - sequence.playerPull.z), facingDoor, t);
  const doorOpen = phase === 'approach' ? 0 : phase === 'open' ? t : phase === 'close' ? 1 - t : 1;
  return { phase, progress, doorOpen, player, driver, seatEye: { ...sequence.seatEye }, playerSeated, driverSeated, driverVisible: true };
}

/** Body clearance, including live pedestrians and officers, without the player itself. */
export function carjackingPointClear(world: World, state: GameState, point: Point, ignoreVehicleId?: string, ignorePedestrianId?: string, radius = WALK_RADIUS): boolean {
  if (Math.max(Math.abs(point.x), Math.abs(point.z)) + radius > world.size / 2 - 1) return false;
  if ([...world.buildings, ...world.obstacles].some(solid => circleIntersectsBox(point.x, point.z, radius, solid))) return false;
  if (state.vehicles.some(car => car.active && car.id !== ignoreVehicleId && circleIntersectsBox(point.x, point.z, radius, car))) return false;
  if (state.pedestrians.some(person => person.id !== ignorePedestrianId && person.state !== 'dead' && dist(person, point) < radius + .36)) return false;
  return !state.officers.some(officer => officer.state !== 'dead' && officer.state !== 'riding' && dist(officer, point) < radius + .38);
}

function segmentClear(world: World, state: GameState, from: Point, to: Point, ignoreVehicleId?: string, radius = WALK_RADIUS): boolean {
  const steps = Math.max(1, Math.ceil(dist(from, to) / .16));
  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    if (!carjackingPointClear(world, state, { x: mix(from.x, to.x, t), z: mix(from.z, to.z, t) }, ignoreVehicleId, undefined, radius)) return false;
  }
  return true;
}

function approachPath(world: World, state: GameState, car: Vehicle, target: Point): Point[] | null {
  const from = { x: state.player.x, z: state.player.z };
  if (segmentClear(world, state, from, target)) return [from, { ...target }];
  const nearby = [...world.buildings, ...world.obstacles, ...state.vehicles.filter(vehicle => vehicle.active)]
    .filter(solid => dist(car, solid) < Math.hypot(solid.width, solid.depth) / 2 + 12);
  const nodes: Point[] = [from, { ...target }];
  for (const solid of [...nearby].sort((a, b) => dist(car, a) - dist(car, b)).slice(0, 14)) {
    const c = Math.cos(solid.yaw), s = Math.sin(solid.yaw);
    for (const side of [-1, 1]) for (const end of [-1, 1]) {
      const x = side * (solid.width / 2 + .68), z = end * (solid.depth / 2 + .68);
      nodes.push({ x: solid.x + c * x + s * z, z: solid.z - s * x + c * z });
    }
  }
  for (const person of [...state.pedestrians.filter(pedestrian => pedestrian.state !== 'dead'),
    ...state.officers.filter(officer => officer.state !== 'dead' && officer.state !== 'riding')].filter(person => dist(car, person) < 7)) {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) nodes.push({ x: person.x + Math.sin(yaw), z: person.z + Math.cos(yaw) });
  }
  const points = nodes.filter((point, index) => index < 2 || carjackingPointClear(world, state, point));
  const people = [...state.pedestrians.filter(person => person.state !== 'dead'), ...state.officers.filter(officer => officer.state !== 'dead' && officer.state !== 'riding')];
  const clear = (a: Point, b: Point): boolean => {
    const length = dist(a, b);
    const corridor = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, yaw: Math.atan2(b.x - a.x, b.z - a.z), width: WALK_RADIUS * 2, depth: length };
    if (nearby.some(solid => boxIntersects(corridor, solid))) return false;
    return !people.some(person => {
      const t = length ? clamp(((person.x - a.x) * (b.x - a.x) + (person.z - a.z) * (b.z - a.z)) / (length * length), 0, 1) : 0;
      return dist(person, { x: mix(a.x, b.x, t), z: mix(a.z, b.z, t) }) < .86;
    });
  };
  const costs = points.map((_, index) => index ? Infinity : 0), previous = points.map(() => -1), visited = new Set<number>();
  for (let iteration = 0; iteration < points.length; iteration++) {
    let current = -1;
    for (let index = 0; index < points.length; index++) if (!visited.has(index) && (current < 0 || costs[index] < costs[current])) current = index;
    if (current < 0 || !Number.isFinite(costs[current]) || costs[current] > 18) break;
    if (current === 1) {
      const path: Point[] = [];
      for (let index = 1; index >= 0; index = previous[index]) path.unshift(points[index]);
      return path;
    }
    visited.add(current);
    for (let next = 0; next < points.length; next++) {
      const cost = costs[current] + dist(points[current], points[next]);
      if (visited.has(next) || cost >= costs[next] || !clear(points[current], points[next])) continue;
      costs[next] = cost; previous[next] = current;
    }
  }
  return null;
}

/** Reserve a complete clear door, pull, landing and entry corridor before stopping traffic. */
export function planCarjacking(world: World, state: GameState, car: Vehicle): CarjackingState | null {
  if (!car.active || car.kind !== 'traffic' || !car.driver || car.model === 'armored' || Math.abs(car.speed) > 12) return null;
  const access = getVehicleAccess(car.model);
  const worldPoint = (point: Point3, seated = false): Point3 => ({
    x: car.x + Math.cos(car.yaw) * point.x + Math.sin(car.yaw) * point.z,
    y: point.y + (seated ? VEHICLE_ROOT_Y : 0),
    z: car.z - Math.sin(car.yaw) * point.x + Math.cos(car.yaw) * point.z,
  });
  const staging = worldPoint({ ...access.approach, z: access.approach.z - .55 });
  if (!carjackingPointClear(world, state, staging)) return null;
  const reach = worldPoint({ x: access.bodyHalfWidth + .10, y: 0, z: access.seatEye.z - .12 });
  const playerPull = worldPoint(access.pullEnd);
  const seat = worldPoint(access.seatRoot, true), seatEye = worldPoint(access.seatEye, true), door = worldPoint(access.doorway, true);
  if (![reach, playerPull, seat, door].every(point => carjackingPointClear(world, state, point, car.id))) return null;
  for (const [a, b] of [[staging, reach], [reach, playerPull], [reach, door], [door, seat]]) if (!segmentClear(world, state, a, b, car.id)) return null;
  // The animated door also needs room to swing outward, not only a clear handle.
  for (let index = 0; index <= 8; index++) {
    const angle = access.doorOpenAngle * index / 8;
    const end = worldPoint({ x: access.doorHinge.x + Math.sin(angle) * access.doorWidth,
      y: 0, z: access.doorHinge.z - Math.cos(angle) * access.doorWidth });
    if (!segmentClear(world, state, worldPoint(access.doorHinge), end, car.id, .12)) return null;
  }
  let driverOut: Point3 | undefined, ejection: Point3 | undefined;
  for (const offset of [.85, -2, 1.6, -2.6]) {
    const out = worldPoint({ x: car.width / 2 + .95, y: 0, z: access.seatEye.z - .40 });
    const landing = worldPoint({ x: car.width / 2 + 1.65, y: .035, z: access.seatEye.z + offset });
    const clearDoor = worldPoint({ x: car.width / 2 + 1.65, y: 0, z: access.seatEye.z - .40 });
    const head = worldPoint({ x: car.width / 2 + 3.25, y: 0, z: access.seatEye.z + offset });
    if (dist(landing, playerPull) < 1.1 || !segmentClear(world, state, seat, out, car.id) ||
      !segmentClear(world, state, out, clearDoor, car.id) || !segmentClear(world, state, clearDoor, landing, car.id) ||
      !segmentClear(world, state, landing, head, car.id, .4)) continue;
    driverOut = out; ejection = landing; break;
  }
  if (!driverOut || !ejection) return null;
  const path = approachPath(world, state, car, staging);
  if (!path) return null;
  const approachDuration = Math.max(.12, pathLength(path) / APPROACH_SPEED);
  return { vehicleId: car.id, driver: { ...car.driver }, elapsed: 0,
    duration: approachDuration + CARJACKING_TIMING.open + CARJACKING_TIMING.pull + CARJACKING_TIMING.fall + CARJACKING_TIMING.enter + CARJACKING_TIMING.close,
    approachDuration, phase: 'approach', phaseProgress: 0, approachPath: path, startYaw: state.player.yaw, carYaw: car.yaw,
    seat, seatEye, door, staging, reach, playerPull, driverOut, ejection, driverReleased: false };
}
