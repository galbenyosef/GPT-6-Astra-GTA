import { angleDelta, boxIntersects, circleIntersectsBox, clamp, dist } from './collision';
import { createPedestrians, createVehicles, MISSION_CAR_ID, routeToTarget, steerToward } from './ai';
import type { CarjackingState, GameState, InputFrame, Pedestrian, Point, PoliceOfficer, SimulationApi, Vehicle, World } from './types';
import { createWorld } from './world';
import { VEHICLE_SPECS } from './vehicles';
import { canPoliceShoot, createCombatState, damageVictim, firePoliceShot, updateCombat } from './combat';
import { policeCanSee, policeEscapeDuration, policeLaneRoute, policeLimit, policeObjective, policeOfficerPath, policeSighting } from './policePursuit';
import { updatePoliceHelicopter } from './policeHelicopter';
import { CARJACKING_TIMING, carjackingPointClear, carjackingReleaseTime, planCarjacking, sampleCarjacking } from './carjacking';

const FOOT_RADIUS = 0.48;
const FIXED_STEP = 1 / 90;
const SPAWN = { x: 13, z: 36 };
const TAU = Math.PI * 2;

/** Deterministic ground-plane dynamics for vertically extruded 3D colliders. */
export class Simulation implements SimulationApi {
  world: World = createWorld();
  state: GameState = {
    time: 0, player: { ...SPAWN, yaw: Math.PI, vehicleId: null, moving: false },
    vehicles: createVehicles(this.world), pedestrians: createPedestrians(this.world),
    mission: { phase: 'available', elapsed: 0, best: null, deliveryHold: 0 },
    police: { wanted: 0, escape: 0, caught: 0, cooldown: 0, lastSeen: null, spotted: false, reinforcementTimer: 7, helicopter: null },
    combat: createCombatState(), officers: [], carjacking: null,
    message: 'A delivery is waiting at the amber beacon. Walk over and press E.', messageUntil: 8, collisions: 0,
  };
  private collisionCooldown = 0;
  private policeRouteTimer = 0;
  private lastInteract = false;
  private lastRestart = false;
  private deathHandled = false;
  private nextPoliceId = 2;
  private officerRoutes = new Map<string, { points: Point[]; waypoint: number; remaining: number }>();
  private policeDriving = new Map<string, { reverse: number; side: number; avoidance: Point | null; avoidTime: number }>();
  private policeVehicleMovingUntil = 0;
  private policeDoorReady = new Map<string, number>();

  getControlled(): Point & { yaw: number } { return this.controlledCar() ?? this.state.player; }

  private controlledCar(): Vehicle | undefined {
    return this.state.vehicles.find(v => v.id === this.state.player.vehicleId);
  }

  private message(text: string, seconds = 4): void {
    this.state.message = text;
    this.state.messageUntil = this.state.time + seconds;
  }

  step(dt: number, input: InputFrame): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (!this.state.combat.dead && input.restart && !this.lastRestart) this.restartMission();
    if (input.interact && !this.lastInteract) this.interact();
    this.lastRestart = input.restart;
    this.lastInteract = input.interact;
    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-7) {
      const tick = Math.min(FIXED_STEP, remaining);
      this.tick(tick, input);
      remaining -= tick;
    }
  }

  private tick(dt: number, input: InputFrame): void {
    const s = this.state;
    s.time += dt;
    this.collisionCooldown = Math.max(0, this.collisionCooldown - dt);
    s.police.cooldown = Math.max(0, s.police.cooldown - dt);
    if (s.combat.dead && s.carjacking) this.cancelCarjacking();
    const car = this.controlledCar();
    if (!s.combat.dead) {
      if (s.carjacking) this.updateCarjacking(dt);
      else if (car) this.updateDriving(car, dt, input); else this.updateWalking(dt, input);
    } else {
      s.player.moving = false;
      if (car) car.speed = 0;
    }
    updateCombat(this.world, s, dt, input, (level, reason) => this.raiseWanted(reason, level));
    this.updatePedestrians(dt);
    this.updateTraffic(dt);
    this.updatePolice(dt);
    if (s.combat.dead) this.updateDeath(dt); else this.updateMission(dt);
  }

  private footBlocked(x: number, z: number, ignoreVehicle?: string, radius = FOOT_RADIUS, ignoreOfficer?: string): boolean {
    if (Math.abs(x) + radius > this.world.size / 2 - 1 || Math.abs(z) + radius > this.world.size / 2 - 1) return true;
    for (const solid of [...this.world.buildings, ...this.world.obstacles]) {
      if (circleIntersectsBox(x, z, radius, solid)) return true;
    }
    if (this.state.vehicles.some(v => v.active && v.id !== ignoreVehicle && circleIntersectsBox(x, z, radius, v))) return true;
    return this.state.officers.some(officer => officer.id !== ignoreOfficer && officer.state !== 'riding' && officer.state !== 'dead' && dist({ x, z }, officer) < radius + 0.38);
  }

  private vehicleBlock(car: Vehicle, x: number, z: number, yaw: number, includePlayer = true, includeOfficers = true): string | null {
    const test = { x, z, yaw, width: car.width, depth: car.depth };
    // The circumscribed radius keeps every corner inside the actual world.
    const extentX = Math.abs(Math.cos(yaw)) * car.width / 2 + Math.abs(Math.sin(yaw)) * car.depth / 2;
    const extentZ = Math.abs(Math.sin(yaw)) * car.width / 2 + Math.abs(Math.cos(yaw)) * car.depth / 2;
    if (Math.abs(x) + extentX > this.world.size / 2 - 1 || Math.abs(z) + extentZ > this.world.size / 2 - 1) return 'boundary';
    for (const solid of [...this.world.buildings, ...this.world.obstacles]) if (boxIntersects(test, solid, 0.035)) return solid.id;
    for (const other of this.state.vehicles) {
      if (other.active && other.id !== car.id && boxIntersects(test, other, 0.035)) return other.id;
    }
    for (const officer of this.state.officers) {
      if (includeOfficers && officer.state !== 'riding' && officer.state !== 'dead' && circleIntersectsBox(officer.x, officer.z, 0.48, test)) return officer.id;
    }
    if (includePlayer && !this.state.player.vehicleId && circleIntersectsBox(this.state.player.x, this.state.player.z, FOOT_RADIUS + 0.15, test)) return 'player';
    return null;
  }

  private updateWalking(dt: number, input: InputFrame): void {
    const p = this.state.player;
    const strafe = Number.isFinite(input.turn) ? clamp(input.turn, -1, 1) : 0;
    const forward = Number.isFinite(input.forward) ? clamp(input.forward, -1, 1) : 0;
    const viewYaw = input.viewYaw;
    // Keep keyboard-only callers facing -Z; a real view supplies its own heading.
    const sin = viewYaw !== undefined && Number.isFinite(viewYaw) ? Math.sin(viewYaw) : 0;
    const cos = viewYaw !== undefined && Number.isFinite(viewYaw) ? Math.cos(viewYaw) : -1;
    const dx = forward * sin - strafe * cos;
    const dz = forward * cos + strafe * sin;
    const length = Math.hypot(dx, dz);
    p.moving = length > 0;
    if (!length) return;
    const speed = input.sprint ? 8 : 5.2;
    const moveX = dx / length * speed * dt;
    const moveZ = dz / length * speed * dt;
    p.yaw += angleDelta(p.yaw, Math.atan2(dx, dz)) * Math.min(1, dt * 16);
    if (!this.footBlocked(p.x + moveX, p.z)) p.x += moveX;
    if (!this.footBlocked(p.x, p.z + moveZ)) p.z += moveZ;
  }

  private updateDriving(car: Vehicle, dt: number, input: InputFrame): void {
    const throttle = Number.isFinite(input.forward) ? clamp(input.forward, -1, 1) : 0;
    const turn = Number.isFinite(input.turn) ? clamp(input.turn, -1, 1) : 0;
    if (input.brake) {
      car.speed = Math.sign(car.speed) * Math.max(0, Math.abs(car.speed) - 20 * dt);
    } else if (throttle) {
      const braking = Math.sign(throttle) !== Math.sign(car.speed) && Math.abs(car.speed) > 0.4;
      car.speed += throttle * (braking ? 17 : throttle > 0 ? 10.2 : 6.4) * dt;
    }
    car.speed *= Math.exp(-(throttle && !input.brake ? 0.11 : 0.56) * dt);
    if (Math.abs(car.speed) < 0.018) car.speed = 0;
    car.speed = clamp(car.speed, -10, 29);
    car.steer += (-turn * 0.58 - car.steer) * Math.min(1, 7 * dt);
    const speedTurn = car.speed / (1 + Math.abs(car.speed) * 0.07);
    let yaw = car.yaw + Math.tan(car.steer) * speedTurn / 3.05 * dt;
    let x = car.x + Math.sin(yaw) * car.speed * dt;
    let z = car.z + Math.cos(yaw) * car.speed * dt;
    let blocked = this.vehicleBlock(car, x, z, yaw, false, false);
    // When steering sweeps the rear corner into a neighbour, retain the heading
    // and allow a clear forward/reverse translation so touching cars can separate.
    if (blocked) {
      const straightX = car.x + Math.sin(car.yaw) * car.speed * dt;
      const straightZ = car.z + Math.cos(car.yaw) * car.speed * dt;
      if (!this.vehicleBlock(car, straightX, straightZ, car.yaw, false, false)) {
        x = straightX; z = straightZ; yaw = car.yaw; blocked = null;
      }
    }
    const impact = Math.abs(car.speed);
    // Scenery is resolved first, so an actor behind a wall cannot be struck.
    const footprint = { x, z, yaw, width: car.width, depth: car.depth };
    const victims = blocked ? [] : [
      ...this.state.pedestrians.filter(person => person.state !== 'dead' && circleIntersectsBox(person.x, person.z, .55, footprint)),
      ...this.state.officers.filter(officer => officer.state !== 'riding' && officer.state !== 'dead' && circleIntersectsBox(officer.x, officer.z, .48, footprint)),
    ];
    if ((blocked || victims.length) && this.collisionCooldown <= 0 && impact > 1.5) {
      this.state.collisions++;
      this.collisionCooldown = .55;
      this.state.police.cooldown = 0;
      this.raiseWanted('Vehicle collision reported. Police are responding.');
    }
    if (victims.length) {
      if (impact >= 6) {
        for (const victim of victims) damageVictim(this.state, victim, 100, (level, reason) => this.raiseWanted(reason, level));
        car.speed *= .58;
      } else {
        blocked = victims[0].id;
        for (const victim of victims) if ('timer' in victim && impact > 1.5) { victim.state = 'fleeing'; victim.timer = 3; }
      }
    }
    if (blocked) {
      car.speed = impact > 3 ? -Math.sign(car.speed) * Math.min(1.3, impact * 0.09) : 0;
    } else {
      car.x = x; car.z = z; car.yaw = yaw % TAU;
    }
    const p = this.state.player;
    p.x = car.x; p.z = car.z; p.yaw = car.yaw; p.moving = Math.abs(car.speed) > 0.1;
  }

  private updateTraffic(dt: number): void {
    for (const car of this.state.vehicles) {
      if (!car.active || car.id === this.state.player.vehicleId || car.id === this.state.carjacking?.vehicleId || car.kind !== 'traffic') continue;
      const index = Number(car.id.slice('traffic-'.length));
      // A common cruising pace keeps the long perimeter loop evenly spaced.
      this.followRoute(car, dt, index >= 8 ? 9 : 8 + index % 3);
    }
    // Cars retain momentum after a slow exit and settle naturally.
    for (const car of this.state.vehicles) {
      if (!car.active || car.id === this.state.player.vehicleId || !['parked', 'mission'].includes(car.kind) || Math.abs(car.speed) < 0.01) continue;
      car.speed *= Math.exp(-4 * dt);
      const x = car.x + Math.sin(car.yaw) * car.speed * dt;
      const z = car.z + Math.cos(car.yaw) * car.speed * dt;
      if (this.vehicleBlock(car, x, z, car.yaw)) car.speed = 0; else { car.x = x; car.z = z; }
    }
  }

  private followRoute(car: Vehicle, dt: number, speed: number, loop = true): void {
    if (!car.route.length) { car.speed = 0; return; }
    let target = car.route[car.waypoint];
    if (dist(car, target) < 3.1) {
      if (car.waypoint + 1 < car.route.length) car.waypoint++;
      else if (loop) car.waypoint = 0;
      else { car.speed = Math.max(0, car.speed - dt * 14); return; }
      target = car.route[car.waypoint];
    }
    const oldYaw = car.yaw;
    steerToward(car, target, dt, speed);
    const x = car.x + Math.sin(car.yaw) * car.speed * dt;
    const z = car.z + Math.cos(car.yaw) * car.speed * dt;
    const dangerBox = { x, z, width: car.width, depth: car.depth + 0.6, yaw: car.yaw };
    const danger = this.state.pedestrians.some(p => p.state !== 'dead' && circleIntersectsBox(p.x, p.z, 0.55, dangerBox)) ||
      this.state.officers.some(officer => (officer.state === 'engaging' || officer.state === 'returning') && circleIntersectsBox(officer.x, officer.z, 0.55, dangerBox));
    const blocked = danger ? 'pedestrian' : this.vehicleBlock(car, x, z, car.yaw);
    if (!blocked) { car.x = x; car.z = z; car.blocked = Math.max(0, car.blocked - dt * 2); }
    else {
      car.yaw = oldYaw;
      car.speed = 0;
      car.blocked += dt;
      // A short, collision-tested backoff gives turning cars room at junctions.
      if (car.blocked > 2.5 && car.blocked < 3.7 && blocked !== 'player' && blocked !== 'pedestrian') {
        const bx = car.x - Math.sin(car.yaw) * 1.7 * dt;
        const bz = car.z - Math.cos(car.yaw) * 1.7 * dt;
        if (!this.vehicleBlock(car, bx, bz, car.yaw)) { car.x = bx; car.z = bz; }
      }
      if (car.blocked > 5) car.blocked = 1;
    }
  }

  private updatePedestrians(dt: number): void {
    for (const p of this.state.pedestrians) {
      if (p.state === 'dead') continue;
      if (p.recoverUntil !== undefined && this.state.time < p.recoverUntil) continue;
      p.phase += dt * (p.state === 'fleeing' ? 13 : 6);
      const danger = this.state.vehicles.find(v => v.active && Math.abs(v.speed) > 4 && dist(v, p) < 7);
      if (danger) { p.state = 'fleeing'; p.timer = 1.2; }
      if (p.state === 'waiting') {
        p.timer -= dt;
        if (p.timer <= 0) p.state = 'walking';
        continue;
      }
      let target = p.route[p.waypoint];
      if (p.state === 'fleeing') {
        p.timer -= dt;
        if (danger) {
          const awayX = p.x - danger.x; const awayZ = p.z - danger.z;
          target = { x: p.x + awayX, z: p.z + awayZ };
        } else if (p.ejectedAt !== undefined && dist(p, target) < .55) {
          p.waypoint = (p.waypoint + 1) % p.route.length;
          target = p.route[p.waypoint];
        }
        if (p.timer <= 0) p.state = 'walking';
      } else if (dist(p, target) < 0.55) {
        p.waypoint = (p.waypoint + 1) % p.route.length;
        p.state = 'waiting'; p.timer = 0.35 + (Number(p.id.match(/\d+$/)?.[0] ?? 0) % 5) * 0.21;
        continue;
      }
      const dx = target.x - p.x; const dz = target.z - p.z;
      const len = Math.hypot(dx, dz);
      if (!len) continue;
      const speed = p.speed * (p.state === 'fleeing' ? 2.15 : 1);
      const x = p.x + dx / len * speed * dt; const z = p.z + dz / len * speed * dt;
      const blockedByPedestrian = this.state.pedestrians.some(other => other !== p && other.state !== 'dead' && dist({ x, z }, other) < 0.76);
      if (!blockedByPedestrian && !this.footBlocked(x, z, undefined, 0.36)) {
        p.x = x; p.z = z; p.yaw += angleDelta(p.yaw, Math.atan2(dx, dz)) * Math.min(1, dt * 10);
      } else {
        this.redirectPedestrian(p);
      }
    }
  }

  private redirectPedestrian(p: Pedestrian): void {
    // Reverse along a known sidewalk segment rather than crossing a building.
    p.route = [...p.route].reverse();
    p.waypoint = (p.route.length - p.waypoint) % p.route.length;
    p.state = 'waiting'; p.timer = 0.45 + (Number(p.id.match(/\d+$/)?.[0] ?? 0) % 7) * 0.17;
  }

  private raiseWanted(reason: string, level: 1 | 3 | 5 = 1): void {
    if (this.state.combat.dead) return;
    const previous = this.state.police.wanted;
    this.state.police.wanted = Math.min(5, Math.max(previous, level));
    this.state.police.escape = 0;
    this.state.police.lastSeen = policeSighting(this.state);
    this.state.police.cooldown = 0;
    if (previous >= level) return;
    this.message(reason, 5);
    this.policeRouteTimer = 0;
    this.state.police.reinforcementTimer = 5;
    this.dispatchPolice(level === 5 ? policeLimit(level) : Math.min(3, policeLimit(this.state.police.wanted)), false);
  }

  private dispatchPolice(count: number, reinforcement: boolean): void {
    const target = this.state.police.lastSeen;
    if (!target) return;
    const roadEnd = this.world.size / 2 - this.world.roadWidth - 2;
    const roadSpacing = this.world.roads[1] - this.world.roads[0];
    const centralResponse = Math.max(Math.abs(target.x), Math.abs(target.z)) < roadSpacing * 1.75;
    // New units enter on clear road sections; an already active car never moves here.
    const outerStations = [-roadEnd, ...this.world.roads.slice(0, -1).flatMap((road, index) => {
      const span = this.world.roads[index + 1] - road;
      return [road + span * 0.25, road + span * 0.75];
    }), roadEnd];
    // The mission district retains its authored dispatch layout and response time.
    const stations = centralResponse ? [-122, -95, -45, 35, 100, 122] : outerStations;
    const roads = centralResponse ? this.world.roads.filter(road => Math.abs(road) <= roadSpacing) : this.world.roads;
    const patrols = this.state.vehicles.filter(car => car.kind === 'police');
    const armoredCount = this.state.police.wanted >= 5 ? 2 : 0;
    const desired = [
      { model: 'armored' as const, count: armoredCount },
      { model: 'sedan' as const, count: Math.min(6, Math.max(0, count - armoredCount)) },
    ];
    const available: Vehicle[] = [];
    for (const group of desired) {
      const matching = patrols.filter(car => car.model === group.model && !this.crewDefeated(car));
      const active = matching.filter(car => car.active).length;
      const reserve = matching.filter(car => !car.active);
      for (let index = 0; index < group.count - active; index++) {
        let car = reserve[index];
        // Keep nearby wrecks and bodies intact, with a finite reserve pool.
        if (!car && this.state.vehicles.filter(vehicle => vehicle.kind === 'police').length < 16) {
          const template = patrols.find(vehicle => vehicle.model === group.model) ?? patrols[0];
          if (!template) break;
          let id = `police-${this.nextPoliceId++}`;
          while (this.state.vehicles.some(vehicle => vehicle.id === id)) id = `police-${this.nextPoliceId++}`;
          const spec = VEHICLE_SPECS[group.model];
          car = { ...template, id, model: group.model, width: spec.width, depth: spec.depth, speed: 0, steer: 0,
            route: [], waypoint: 0, blocked: 0, active: false };
          this.state.vehicles.push(car);
        }
        if (car) available.push(car);
      }
    }
    for (const police of available) {
      const candidates = roads.flatMap(road => stations.flatMap(t => [{ x: road, z: t }, { x: t, z: road }]));
      const occupied = this.state.vehicles.filter(car => car.kind === 'police' && car.active && !this.crewDefeated(car));
      const score = (point: Point): number => Math.abs(dist(point, target) - (reinforcement ? 100 : 58)) +
        occupied.reduce((sum, other) => sum + Math.max(0, 65 - dist(point, other)) * 2.5, 0);
      candidates.sort((a, b) => score(a) - score(b));
      const heading = (point: Point): number => {
        const route = routeToTarget(point, target, this.world);
        const first = route.find(next => dist(point, next) > 4) ?? target;
        return Math.atan2(first.x - point.x, first.z - point.z);
      };
      const spot = candidates.find(point => dist(point, target) > (reinforcement ? 72 : 40) &&
        (dist(point, this.getControlled()) >= 125 || !policeCanSee(this.world, this.state, point, police.id, Infinity)) &&
        occupied.every(other => dist(point, other) > 18) && !this.vehicleBlock(police, point.x, point.z, heading(point)));
      if (spot) {
        police.x = spot.x; police.z = spot.z; police.yaw = heading(spot); police.speed = 0;
        police.active = true; police.route = []; police.waypoint = 0; police.blocked = 0;
        this.policeDriving.delete(police.id);
        this.policeDoorReady.delete(police.id);
      }
    }
  }

  private updateDeath(dt: number): void {
    const s = this.state;
    if (s.carjacking) this.cancelCarjacking();
    if (!this.deathHandled) {
      this.deathHandled = true;
      if (s.mission.phase === 'collect' || s.mission.phase === 'deliver') s.mission.phase = 'failed';
      s.combat.reload = null;
      s.player.moving = false;
      const car = this.controlledCar();
      if (car) car.speed = 0;
      this.message('You were taken down. Returning to Portside Dispatch…', 4);
    }
    s.combat.respawnIn = Math.max(0, s.combat.respawnIn - dt);
    if (s.combat.respawnIn > 0) return;
    this.restartMission();
    s.combat = createCombatState();
    this.deathHandled = false;
    this.message('Back on your feet. Your parked vehicles are still in the city.', 4);
  }

  private policeCrew(car: Vehicle): PoliceOfficer[] {
    return this.state.officers.filter(officer => officer.vehicleId === car.id);
  }

  private crewDefeated(car: Vehicle): boolean {
    const crew = this.policeCrew(car);
    return crew.length > 0 && crew.every(officer => officer.state === 'dead');
  }

  private ensureCrew(car: Vehicle): PoliceOfficer[] {
    const crew = this.policeCrew(car);
    const count = car.model === 'armored' ? 2 : 1;
    for (let slot = crew.length; slot < count; slot++) {
      const officer: PoliceOfficer = { id: `officer-${car.id}${slot ? `-${slot}` : ''}`, vehicleId: car.id,
        x: car.x, z: car.z, yaw: car.yaw, health: 100, state: 'riding', fireCooldown: 1.2, phase: 0,
        deadAt: null, weapon: car.model === 'armored' ? 'rifle' : 'pistol', squadSlot: slot, burst: 0 };
      this.state.officers.push(officer); crew.push(officer);
    }
    return crew;
  }

  private officerDoors(car: Vehicle, officer: PoliceOfficer): Point[] {
    const sideDistance = car.width / 2 + 0.9;
    const preferred = (officer.squadSlot ?? 0) % 2 ? -1 : 1;
    const forward = car.model === 'armored' ? VEHICLE_SPECS.armored.entryOffsetZ : .5;
    return [preferred, -preferred].flatMap(side => [forward, forward - 1.5, forward + 1].map(offset => ({
      x: car.x + Math.cos(car.yaw) * side * sideDistance + Math.sin(car.yaw) * offset,
      z: car.z - Math.sin(car.yaw) * side * sideDistance + Math.cos(car.yaw) * offset,
    })));
  }

  private officerBlocked(officer: PoliceOfficer, point: Point): boolean {
    if (this.footBlocked(point.x, point.z, undefined, 0.38, officer.id)) return true;
    if (!this.state.player.vehicleId && !this.state.combat.dead && dist(point, this.state.player) < 0.9) return true;
    if (this.state.pedestrians.some(person => person.state !== 'dead' && dist(point, person) < 0.74)) return true;
    return this.state.officers.some(other => other !== officer && other.state !== 'riding' && other.state !== 'dead' && dist(point, other) < 0.78);
  }

  private dismountOfficer(car: Vehicle, officer: PoliceOfficer): void {
    if (this.state.time < (this.policeDoorReady.get(car.id) ?? 0)) return;
    const exit = this.officerDoors(car, officer).find(point => !this.officerBlocked(officer, point));
    if (!exit) return;
    officer.x = exit.x; officer.z = exit.z; officer.yaw = car.yaw;
    officer.state = 'engaging'; officer.fireCooldown = 1.2 + (officer.squadSlot ?? 0) * .25 + Number(car.id.slice('police-'.length)) % 2 * 0.2;
    officer.burst = 0;
    this.policeDoorReady.set(car.id, this.state.time + .4);
    car.speed = 0; car.route = []; car.waypoint = 0;
    this.officerRoutes.delete(officer.id);
  }

  private brakePolice(car: Vehicle, dt: number): void {
    car.speed = Math.sign(car.speed) * Math.max(0, Math.abs(car.speed) - 18 * dt);
    const x = car.x + Math.sin(car.yaw) * car.speed * dt;
    const z = car.z + Math.cos(car.yaw) * car.speed * dt;
    if (this.vehicleBlock(car, x, z, car.yaw) || this.policePedestrianHazard(car, x, z, car.yaw)) car.speed = 0;
    else { car.x = x; car.z = z; }
  }

  private policePedestrianHazard(car: Vehicle, x: number, z: number, yaw: number): boolean {
    return this.state.pedestrians.some(person => person.state !== 'dead' &&
      circleIntersectsBox(person.x, person.z, .55, { x, z, yaw, width: car.width, depth: car.depth + .8 }));
  }

  private moveOfficer(officer: PoliceOfficer, target: Point, dt: number): void {
    const distance = dist(officer, target);
    if (distance < 0.15) return;
    const direction = Math.atan2(target.x - officer.x, target.z - officer.z);
    const side = Number(officer.id.slice(-1)) % 2 ? -1 : 1;
    const stride = Math.min(distance, dt * 4.4);
    // Collision-tested tangents let a pursuing officer pass street furniture
    // and walk around a parked patrol instead of snapping through its body.
    for (const offset of [0, side * Math.PI / 4, -side * Math.PI / 4, side * Math.PI / 2, -side * Math.PI / 2]) {
      const yaw = direction + offset;
      const next = { x: officer.x + Math.sin(yaw) * stride, z: officer.z + Math.cos(yaw) * stride };
      if (this.officerBlocked(officer, next)) continue;
      officer.x = next.x; officer.z = next.z;
      officer.yaw += angleDelta(officer.yaw, yaw) * Math.min(1, dt * 12);
      officer.phase += stride * 2.8;
      break;
    }
  }

  private updateOfficer(officer: PoliceOfficer, car: Vehicle, target: Point, dt: number, returning: boolean, visible = true): void {
    if (officer.state === 'dead') return;
    if (officer.state === 'riding') { officer.x = car.x; officer.z = car.z; officer.yaw = car.yaw; return; }
    car.speed = 0;
    officer.fireCooldown = Math.max(0, officer.fireCooldown - dt);
    if (returning) {
      const newlyReturning = officer.state !== 'returning';
      officer.state = 'returning';
      officer.burst = 0;
      if (newlyReturning) this.officerRoutes.delete(officer.id);
      const doors = this.officerDoors(car, officer).sort((a, b) => dist(officer, a) - dist(officer, b));
      const door = doors.find(point => !this.officerBlocked(officer, point)) ?? doors[0];
      if (dist(officer, door) < 0.6) {
        officer.state = 'riding'; officer.x = car.x; officer.z = car.z; officer.yaw = car.yaw;
        car.route = []; car.waypoint = 0; this.policeRouteTimer = 0;
        this.officerRoutes.delete(officer.id);
      } else {
        let route = this.officerRoutes.get(officer.id);
        if (!route || route.remaining <= 0) {
          route = { points: policeOfficerPath(this.world, this.state, officer, door), waypoint: 0, remaining: 3 };
          this.officerRoutes.set(officer.id, route);
        }
        route.remaining -= dt;
        while (route.waypoint < route.points.length - 1 && dist(officer, route.points[route.waypoint]) < .55) route.waypoint++;
        const goal = route.points[route.waypoint];
        if (goal) this.moveOfficer(officer, goal, dt);
      }
      return;
    }
    officer.state = 'engaging';
    const canShoot = visible && canPoliceShoot(this.world, this.state, officer);
    const distance = dist(officer, target);
    if (distance > (officer.weapon === 'rifle' ? 20 : 12) || !canShoot) {
      let goal = target;
      if (!canShoot) {
        let route = this.officerRoutes.get(officer.id);
        if (!route || route.remaining <= 0) {
          route = { points: [...routeToTarget(officer, target, this.world), { x: target.x, z: target.z }], waypoint: 0, remaining: 1.5 };
          this.officerRoutes.set(officer.id, route);
        }
        route.remaining -= dt;
        while (route.waypoint < route.points.length - 1 && dist(officer, route.points[route.waypoint]) < 1) route.waypoint++;
        goal = route.points[route.waypoint];
      } else this.officerRoutes.delete(officer.id);
      this.moveOfficer(officer, goal, dt);
    }
    officer.yaw += angleDelta(officer.yaw, Math.atan2(target.x - officer.x, target.z - officer.z)) * Math.min(1, dt * 10);
    if (canShoot && distance < (officer.weapon === 'rifle' ? 76 : 48) && officer.fireCooldown <= 0 && !this.state.combat.dead) {
      firePoliceShot(this.world, this.state, officer);
      if (officer.weapon === 'rifle') {
        officer.burst = ((officer.burst ?? 0) + 1) % 3;
        officer.fireCooldown = officer.burst ? .18 : 1.1;
      } else officer.fireCooldown = 0.85 + Number(car.id.slice('police-'.length)) % 2 * 0.18;
    }
  }

  private lineClear(from: Point, to: Point): boolean {
    const length = dist(from, to);
    const n = Math.ceil(length / 1.8);
    for (let i = 1; i < n; i++) {
      const x = from.x + (to.x - from.x) * i / n; const z = from.z + (to.z - from.z) * i / n;
      if ([...this.world.buildings, ...this.world.obstacles].some(s => circleIntersectsBox(x, z, 1.25, s))) return false;
    }
    return true;
  }

  private pursuitRoute(car: Vehicle, target: Point): Point[] {
    const route = routeToTarget(car, target, this.world);
    if (this.state.police.wanted < 3 || route.length < 2) return route;
    const entry = route[0];
    const lane = this.world.roadWidth / 2;
    const alreadyOnVerticalRoad = this.world.roads.includes(entry.x) && Math.abs(entry.z - car.z) < 0.01 &&
      Math.abs(Math.cos(car.yaw)) > 0.7 && Math.abs(entry.x - car.x) + car.width / 2 < lane;
    const alreadyOnHorizontalRoad = this.world.roads.includes(entry.z) && Math.abs(entry.x - car.x) < 0.01 &&
      Math.abs(Math.sin(car.yaw)) > 0.7 && Math.abs(entry.z - car.z) + car.width / 2 < lane;
    // A patrol already in a lane can merge toward the next forward waypoint.
    // Turning sideways to its current road projection blocks following units.
    return alreadyOnVerticalRoad || alreadyOnHorizontalRoad ? route.slice(1) : route;
  }

  private drivePolice(car: Vehicle, dt: number, maximum: number): void {
    if (!car.route.length) { this.brakePolice(car, dt); return; }
    let memory = this.policeDriving.get(car.id);
    if (!memory) {
      memory = { reverse: 0, side: Number(car.id.slice(7)) % 2 ? -1 : 1, avoidance: null, avoidTime: 0 };
      this.policeDriving.set(car.id, memory);
    }
    memory.avoidTime -= dt;
    if (memory.avoidTime <= 0 || memory.avoidance && dist(car, memory.avoidance) < 3) memory.avoidance = null;
    if (memory.reverse > 0) {
      memory.reverse -= dt;
      const yaw = car.yaw + memory.side * dt * .48;
      const x = car.x - Math.sin(yaw) * dt * 3.4, z = car.z - Math.cos(yaw) * dt * 3.4;
      if (!this.vehicleBlock(car, x, z, yaw) && !this.policePedestrianHazard(car, x, z, yaw)) { car.x = x; car.z = z; car.yaw = yaw; car.speed = -3.4; }
      else {
        const bx = car.x - Math.sin(car.yaw) * dt * 3.4, bz = car.z - Math.cos(car.yaw) * dt * 3.4;
        if (!this.vehicleBlock(car, bx, bz, car.yaw) && !this.policePedestrianHazard(car, bx, bz, car.yaw)) { car.x = bx; car.z = bz; car.speed = -3.4; }
        else car.speed = 0;
      }
      if (memory.reverse <= 0) { car.blocked = 0; car.speed = 0; memory.side *= -1; this.policeRouteTimer = 0; }
      return;
    }
    let target = car.route[car.waypoint];
    while (car.waypoint < car.route.length - 1 && dist(car, target) < 5) target = car.route[++car.waypoint];
    if (car.waypoint === car.route.length - 1 && dist(car, target) < 2.8) { this.brakePolice(car, dt); return; }
    let desiredSpeed = maximum;
    const distance = dist(car, target);
    const next = car.route[car.waypoint + 1];
    if (next) {
      const incoming = Math.atan2(target.x - car.x, target.z - car.z);
      const outgoing = Math.atan2(next.x - target.x, next.z - target.z);
      if (Math.abs(angleDelta(incoming, outgoing)) > .45) desiredSpeed = Math.min(desiredSpeed, Math.sqrt(4.5 ** 2 + 21 * Math.max(0, distance - 6)));
    } else desiredSpeed = Math.min(desiredSpeed, Math.sqrt(5 ** 2 + 20 * Math.max(0, distance - 4)));

    const forward = { x: Math.sin(car.yaw), z: Math.cos(car.yaw) };
    const right = { x: forward.z, z: -forward.x };
    const lookAhead = 10 + Math.max(0, car.speed) * .9;
    let obstacle: Vehicle | undefined;
    let gap = Infinity;
    for (const other of this.state.vehicles) {
      if (!other.active || other === car) continue;
      const dx = other.x - car.x, dz = other.z - car.z;
      const along = dx * forward.x + dz * forward.z;
      const across = Math.abs(dx * right.x + dz * right.z);
      const otherSide = Math.abs(Math.sin(other.yaw - car.yaw)) * other.depth / 2 + Math.abs(Math.cos(other.yaw - car.yaw)) * other.width / 2;
      if (along > 0 && along < lookAhead && across < car.width / 2 + otherSide + .65 && along < gap) { obstacle = other; gap = along; }
    }
    if (obstacle && !memory.avoidance) {
      const relativeSpeed = Math.max(0, obstacle.speed * Math.cos(obstacle.yaw - car.yaw));
      desiredSpeed = Math.min(desiredSpeed, Math.max(0, relativeSpeed + (gap - car.depth / 2 - obstacle.depth / 2 - 3) * 1.4));
      if (obstacle.id !== this.state.player.vehicleId && gap < 22 && (relativeSpeed < maximum - 3 || car.blocked > .15)) {
        for (const side of [memory.side, -memory.side]) {
          const shift = (car.width + obstacle.width) / 2 + 2;
          const bypass = { x: obstacle.x + forward.x * 9 + right.x * side * shift, z: obstacle.z + forward.z * 9 + right.z * side * shift };
          const middle = { x: car.x + forward.x * Math.max(4, gap * .4) + right.x * side * shift, z: car.z + forward.z * Math.max(4, gap * .4) + right.z * side * shift };
          if (this.vehicleBlock(car, middle.x, middle.z, car.yaw) || this.vehicleBlock(car, bypass.x, bypass.z, car.yaw)) continue;
          // Stay inside a road corridor while going around civilian traffic.
          const inRoad = this.world.roads.some(road => Math.abs(bypass.x - road) < this.world.roadWidth / 2 - car.width || Math.abs(bypass.z - road) < this.world.roadWidth / 2 - car.width);
          if (!inRoad || !this.lineClear(car, middle) || !this.lineClear(middle, bypass)) continue;
          memory.avoidance = bypass; memory.avoidTime = 2.8; memory.side = side;
          desiredSpeed = Math.min(maximum, 12); break;
        }
      }
    }
    if (memory.avoidance) { target = memory.avoidance; desiredSpeed = Math.min(maximum, 14); }
    const angle = angleDelta(car.yaw, Math.atan2(target.x - car.x, target.z - car.z));
    if (Math.abs(angle) > .55) desiredSpeed = Math.min(desiredSpeed, Math.abs(angle) > 1.2 ? 3.5 : 6.5);
    car.speed += clamp(desiredSpeed - car.speed, -15 * dt, 8.5 * dt);
    const yaw = car.yaw + clamp(angle, -(0.65 + Math.abs(car.speed) * .12) * dt, (0.65 + Math.abs(car.speed) * .12) * dt);
    const x = car.x + Math.sin(yaw) * car.speed * dt, z = car.z + Math.cos(yaw) * car.speed * dt;
    const danger = this.policePedestrianHazard(car, x, z, yaw);
    const blocked = danger ? 'pedestrian' : this.vehicleBlock(car, x, z, yaw);
    if (!blocked) {
      car.x = x; car.z = z; car.yaw = yaw; car.steer = clamp(-angle, -.55, .55);
      car.blocked = Math.abs(car.speed) > .5 ? Math.max(0, car.blocked - dt * 2) : car.blocked + dt;
    } else {
      // A turning rear corner can touch a neighbour while straight motion is clear.
      const sx = car.x + Math.sin(car.yaw) * car.speed * dt, sz = car.z + Math.cos(car.yaw) * car.speed * dt;
      if (!danger && !this.vehicleBlock(car, sx, sz, car.yaw)) { car.x = sx; car.z = sz; }
      else car.speed = 0;
      car.blocked += dt;
    }
    if (car.blocked > 1.1 && blocked !== 'player' && blocked !== 'pedestrian') {
      memory.reverse = .85 + Number(car.id.slice(7)) % 3 * .2;
      memory.avoidance = null; car.speed = 0;
    }
  }

  private updatePolice(dt: number): void {
    const s = this.state;
    const actualTarget = this.getControlled();
    if (s.combat.dead) {
      for (const car of s.vehicles) if (car.kind === 'police') car.speed = 0;
      s.police.spotted = false; s.police.helicopter = null;
      return;
    }
    const retired = new Set<string>();
    for (const car of s.vehicles.filter(vehicle => vehicle.kind === 'police')) {
      const crew = this.policeCrew(car);
      if (!crew.length || crew.some(officer => officer.state !== 'dead' || s.time - (officer.deadAt ?? s.time) < 8 || dist(officer, actualTarget) < 45) || dist(car, actualTarget) < 45) continue;
      if (dist(car, actualTarget) < 125 && policeCanSee(this.world, s, car, car.id, Infinity)) continue;
      if (crew.some(officer => dist(officer, actualTarget) < 125 && policeCanSee(this.world, s, officer, undefined, Infinity))) continue;
      retired.add(car.id);
      car.active = false; car.speed = 0; car.route = []; car.waypoint = 0;
      this.policeDriving.delete(car.id); this.policeDoorReady.delete(car.id);
      for (const officer of crew) this.officerRoutes.delete(officer.id);
    }
    s.vehicles = s.vehicles.filter(car => !retired.has(car.id) || car.id === 'police-0' || car.id === 'police-1');
    // Keep a fallen partner attached to a surviving crew, so neither the crew
    // nor its occupied vehicle can be retired or accidentally replenished.
    s.officers = s.officers.filter(officer => !retired.has(officer.vehicleId));
    if (dist(actualTarget, this.world.restricted) < this.world.restricted.radius && s.police.cooldown <= 0) this.raiseWanted('Restricted depot! Patrols are closing in.');
    const activeCars = () => s.vehicles.filter(car => car.kind === 'police' && car.active && car.id !== s.player.vehicleId);
    const sightings = new Map<string, boolean>();
    const officerSightings = new Map<string, boolean>();
    let nearestVisible = Infinity;
    s.police.spotted = false;
    s.police.spotted = updatePoliceHelicopter(this.world, s, dt);
    if (s.combat.dead) {
      s.police.helicopter = null; s.police.spotted = false;
      for (const car of activeCars()) car.speed = 0;
      return;
    }
    for (const car of activeCars()) {
      const crew = s.police.wanted >= 3 ? this.ensureCrew(car) : this.policeCrew(car);
      const riding = !crew.length || crew.some(officer => officer.state === 'riding');
      let visible = riding && !!s.police.wanted && policeCanSee(this.world, s, car, car.id);
      if (visible) nearestVisible = Math.min(nearestVisible, dist(car, actualTarget));
      for (const officer of crew) {
        if (officer.state === 'dead') continue;
        const seesPlayer = officer.state === 'riding' ? visible : !!s.police.wanted && policeCanSee(this.world, s, officer);
        officerSightings.set(officer.id, seesPlayer);
        if (seesPlayer) nearestVisible = Math.min(nearestVisible, dist(officer.state === 'riding' ? car : officer, actualTarget));
        visible ||= seesPlayer;
      }
      sightings.set(car.id, visible);
      s.police.spotted ||= visible;
    }
    if (s.police.spotted) {
      s.police.lastSeen = policeSighting(s);
      if (s.police.lastSeen.inVehicle && s.police.lastSeen.speed > 3) this.policeVehicleMovingUntil = s.time + .9;
    }
    if (s.police.wanted) {
      s.police.reinforcementTimer -= dt;
      if (s.police.reinforcementTimer <= 0) {
        const alive = activeCars().filter(car => !this.crewDefeated(car)).length;
        this.dispatchPolice(Math.min(policeLimit(s.police.wanted), alive + 1), true);
        s.police.reinforcementTimer = s.police.wanted >= 3 ? 4.5 : 8;
      }
    }
    const sight = s.police.lastSeen;
    const policeCars = activeCars().sort((a, b) => sight ? dist(a, sight) - dist(b, sight) : a.id.localeCompare(b.id));
    const chasingVehicle = !!sight?.inVehicle && (sight.speed > 3 || s.time < this.policeVehicleMovingUntil);
    this.policeRouteTimer -= dt;
    let rank = 0;
    for (const police of policeCars) {
      const crew = s.police.wanted >= 3 ? this.ensureCrew(police) : this.policeCrew(police);
      const liveCrew = crew.filter(officer => officer.state !== 'dead');
      if (crew.length && !liveCrew.length) { police.speed = 0; continue; }
      const unitRank = rank++;
      const target = sight ? policeObjective(this.world, sight, unitRank, s.police.spotted, s.time) : police;
      const canSee = sightings.get(police.id) ?? false;
      for (const officer of liveCrew) {
        if (officer.state === 'riding') continue;
        const seesPlayer = officerSightings.get(officer.id) ?? false;
        const farOnFoot = !!sight && !seesPlayer && dist(officer, sight) > 48;
        this.updateOfficer(officer, police, sight && s.police.spotted ? sight : target, dt, s.police.wanted < 3 || chasingVehicle || farOnFoot, seesPlayer);
      }
      if (s.combat.dead) {
        s.police.helicopter = null; s.police.spotted = false;
        for (const car of activeCars()) car.speed = 0;
        return;
      }
      if (s.police.wanted && sight) {
        const distance = dist(police, sight);
        const searchingOnFoot = !s.police.spotted && !sight.inVehicle && distance < 14;
        const dismount = liveCrew.length > 0 && s.police.wanted >= 3 && !chasingVehicle &&
          !liveCrew.some(officer => officer.state === 'returning') &&
          (canSee && distance < (police.model === 'armored' ? 32 : 22) || searchingOnFoot);
        if (dismount) {
          this.brakePolice(police, dt);
          const officer = liveCrew.find(unit => unit.state === 'riding');
          if (officer && Math.abs(police.speed) < .25) {
            this.dismountOfficer(police, officer);
            if (officer.state === 'engaging') this.updateOfficer(officer, police, target, dt, false, officerSightings.get(officer.id) ?? false);
          }
        }
        if (!dismount && liveCrew.every(officer => officer.state === 'riding')) {
          if (this.policeRouteTimer <= 0 || !police.route.length) {
            const direct = unitRank < 2 && distance < 38 && canSee && this.lineClear(police, target);
            police.route = direct ? [{ x: target.x, z: target.z }] : policeLaneRoute(police, this.pursuitRoute(police, target));
            if (!police.route.length && dist(police, target) > 3 && this.lineClear(police, target)) police.route = [{ ...target }];
            police.waypoint = 0;
          }
          const maximum = s.police.wanted >= 3 ? chasingVehicle ? 27 - unitRank % 3 * 1.5 : 19 : sight.inVehicle ? 23 : 14;
          this.drivePolice(police, dt, s.police.spotted ? maximum : Math.min(maximum, 17));
        }
      } else if (liveCrew.every(officer => officer.state === 'riding')) {
        if (!police.route.length || police.waypoint >= police.route.length - 1 && dist(police, police.route[police.waypoint]) < 4) {
          const road = this.world.roads[(Number(police.id.slice(7)) + Math.floor(s.time / 20)) % this.world.roads.length];
          const extent = this.world.size / 2 - this.world.roadWidth * 1.5;
          police.route = policeLaneRoute(police, routeToTarget(police, { x: road, z: s.time % 40 < 20 ? -extent : extent }, this.world));
          police.waypoint = 0;
        }
        this.drivePolice(police, dt, 8);
      }
      if (liveCrew.some(officer => officer.state !== 'riding')) police.speed = 0;
      for (const officer of liveCrew) if (officer.state === 'riding') { officer.x = police.x; officer.z = police.z; officer.yaw = police.yaw; }
    }
    if (this.policeRouteTimer <= 0) this.policeRouteTimer = .6;
    if (!s.police.wanted) return;
    const controlledSpeed = Math.abs(this.controlledCar()?.speed ?? 0);
    if (s.police.wanted >= 3) s.police.caught = 0;
    else if (nearestVisible < (s.player.vehicleId ? 5.4 : 4) && controlledSpeed < 4) s.police.caught += dt;
    else s.police.caught = Math.max(0, s.police.caught - dt * 1.5);
    if (s.police.caught >= 3) {
      s.police.wanted = 0; s.police.caught = 0; s.police.escape = 0; s.police.cooldown = 8; s.police.spotted = false; s.police.helicopter = null;
      if (this.controlledCar()) this.controlledCar()!.speed = 0;
      if (s.mission.phase === 'collect' || s.mission.phase === 'deliver') {
        s.mission.phase = 'failed';
        this.message('Stopped by the patrol. Press T to retry the delivery.', 7);
      } else this.message('Stopped by the patrol. Heat cleared. You can keep exploring.', 7);
    } else {
      s.police.escape = s.police.spotted ? 0 : s.police.escape + dt;
      if (s.police.escape >= policeEscapeDuration(s.police.wanted)) {
        s.police.wanted = 0; s.police.escape = 0; s.police.caught = 0; s.police.cooldown = 5; s.police.spotted = false; s.police.helicopter = null;
        for (const officer of s.officers) if (officer.state === 'engaging') {
          officer.state = 'returning'; this.officerRoutes.delete(officer.id);
        }
        this.message('You lost the patrol. Heat cleared.', 4);
      }
    }
  }

  private updateMission(dt: number): void {
    const m = this.state.mission;
    if (m.phase === 'collect' || m.phase === 'deliver') m.elapsed += dt;
    if (m.phase !== 'deliver') return;
    const car = this.controlledCar();
    if (car?.id === MISSION_CAR_ID && dist(car, this.world.destination) < 7 && Math.abs(car.speed) < 1.15 && !this.state.police.wanted) {
      m.deliveryHold += dt;
      if (m.deliveryHold >= 1.25) {
        m.phase = 'success';
        m.best = m.best === null ? m.elapsed : Math.min(m.best, m.elapsed);
        this.message('Delivery complete. Portside thanks you! Press T to replay.', 8);
      }
    } else m.deliveryHold = 0;
  }

  private nearbyVehicle(): Vehicle | undefined {
    const p = this.state.player;
    const entryDistance = (v: Vehicle) => {
      const offset = VEHICLE_SPECS[v.model].entryOffsetZ;
      const cabDistance = dist(p, { x: v.x + Math.sin(v.yaw) * offset, z: v.z + Math.cos(v.yaw) * offset });
      // Retain the original reach around the body, including a safe rear exit,
      // and extend it to the forward cab of longer vehicles.
      return Math.min(dist(p, v), cabDistance);
    };
    return this.state.vehicles.filter(v => v.active && v.kind !== 'police' &&
      Math.abs(v.speed) <= (v.kind === 'traffic' && v.driver ? 12 : 1.5) && entryDistance(v) < 4.5)
      .sort((a, b) => entryDistance(a) - entryDistance(b))[0];
  }

  private releaseDriver(sequence: CarjackingState, car: Vehicle): void {
    sequence.driverReleased = true;
    car.driver = null; car.kind = 'parked'; car.speed = 0; car.route = []; car.waypoint = 0;
    if (this.state.pedestrians.some(person => person.id === sequence.driver.id)) return;
    const sample = sampleCarjacking(sequence);
    const sidewalk = this.state.pedestrians.flatMap(person => person.route)
      .filter(point => dist(point, sequence.ejection) > 5 && carjackingPointClear(this.world, this.state, point))
      .sort((a, b) => dist(a, sequence.ejection) - dist(b, sequence.ejection))[0];
    const extent = this.world.size / 2 - 2;
    const fallback = { x: clamp(sequence.ejection.x + Math.cos(car.yaw) * 12, -extent, extent),
      z: clamp(sequence.ejection.z - Math.sin(car.yaw) * 12, -extent, extent) };
    const route = policeOfficerPath(this.world, this.state, sequence.ejection, sidewalk ?? fallback);
    const path = route.length ? route : [{ ...sequence.ejection }];
    const recoverStart = this.state.time + Math.max(0, sequence.duration - sequence.elapsed);
    this.state.pedestrians.push({ id: sequence.driver.id, color: sequence.driver.color,
      x: sample.driver.x, z: sample.driver.z, yaw: sample.driver.yaw, health: 100, deadAt: null,
      speed: 1.55, state: 'fleeing', timer: 6, phase: 0,
      route: [...path, ...path.slice(0, -1).reverse(), { x: sequence.ejection.x, z: sequence.ejection.z }], waypoint: 0,
      ejectedAt: this.state.time, recoverStart, recoverUntil: recoverStart + CARJACKING_TIMING.recover });
  }

  private updateCarjacking(dt: number): void {
    const s = this.state, sequence = s.carjacking;
    if (!sequence) return;
    const car = s.vehicles.find(vehicle => vehicle.id === sequence.vehicleId);
    if (!car?.active || !sequence.driverReleased && car.driver?.id !== sequence.driver.id) { this.cancelCarjacking(); return; }
    const elapsed = Math.min(sequence.duration, sequence.elapsed + dt);
    const sample = sampleCarjacking({ ...sequence, elapsed });
    const ownCar = sample.phase === 'approach' ? undefined : car.id;
    if (!carjackingPointClear(this.world, s, sample.player, ownCar, sequence.driver.id, sample.phase === 'approach' ? FOOT_RADIUS : .30) ||
      !carjackingPointClear(this.world, s, sample.driver, car.id, sequence.driver.id, .36)) {
      this.cancelCarjacking();
      this.message('Entry blocked. Find a clear approach to the driver’s door.', 3);
      return;
    }
    sequence.elapsed = elapsed; sequence.phase = sample.phase; sequence.phaseProgress = sample.progress;
    car.speed = 0; car.steer = 0;
    s.player.x = sample.player.x; s.player.z = sample.player.z; s.player.yaw = sample.player.yaw;
    s.player.moving = sample.phase === 'approach' || sample.phase === 'enter';
    if (!sequence.driverReleased && elapsed >= carjackingReleaseTime(sequence)) this.releaseDriver(sequence, car);
    const driver = sequence.driverReleased ? s.pedestrians.find(person => person.id === sequence.driver.id) : undefined;
    if (driver && driver.state !== 'dead') { driver.x = sample.driver.x; driver.z = sample.driver.z; driver.yaw = sample.driver.yaw; }
    if (elapsed < sequence.duration) return;
    car.driver = null; car.kind = 'parked'; car.route = []; car.waypoint = 0;
    s.player.vehicleId = car.id; s.player.x = car.x; s.player.z = car.z; s.player.yaw = car.yaw; s.player.moving = false;
    if (driver && driver.state !== 'dead') {
      driver.recoverStart = s.time; driver.recoverUntil = s.time + CARJACKING_TIMING.recover;
    }
    s.carjacking = null;
    this.message('Vehicle taken. W accelerates · S brakes / reverses · E exits when slow.', 4);
  }

  private cancelCarjacking(): void {
    const s = this.state, sequence = s.carjacking;
    if (!sequence) return;
    const car = s.vehicles.find(vehicle => vehicle.id === sequence.vehicleId);
    if (car) {
      car.speed = 0;
      if (sequence.driverReleased) { car.driver = null; car.kind = 'parked'; car.route = []; car.waypoint = 0; }
    }
    const current = { x: s.player.x, z: s.player.z };
    const safe = [current, sequence.staging, sequence.playerPull, ...sequence.approachPath.slice().reverse()]
      .find(point => carjackingPointClear(this.world, s, point, undefined, sequence.driver.id));
    if (safe) { s.player.x = safe.x; s.player.z = safe.z; }
    if (sequence.driverReleased) {
      const driver = s.pedestrians.find(person => person.id === sequence.driver.id);
      if (driver && driver.state !== 'dead') {
        driver.recoverStart = s.time; driver.recoverUntil = s.time + CARJACKING_TIMING.recover;
      }
    }
    s.player.moving = false;
    s.carjacking = null;
  }

  interact(): void {
    const s = this.state;
    if (s.combat.dead || s.carjacking) return;
    const controlled = this.controlledCar();
    if (controlled) {
      if (Math.abs(controlled.speed) > 1.8) { this.message('Slow down to exit safely.', 2); return; }
      const forward = { x: Math.sin(controlled.yaw), z: Math.cos(controlled.yaw) };
      const right = { x: Math.cos(controlled.yaw), z: -Math.sin(controlled.yaw) };
      const cabOffset = VEHICLE_SPECS[controlled.model].entryOffsetZ;
      const sideDistance = Math.max(2.05, controlled.width / 2 + FOOT_RADIUS + 0.3);
      const exits = [1, -1].flatMap(side => [cabOffset, cabOffset + 1.5, cabOffset - 1.5].map(offset => ({ x: controlled.x + right.x * side * sideDistance + forward.x * offset, z: controlled.z + right.z * side * sideDistance + forward.z * offset })));
      const rearDistance = controlled.depth / 2 + FOOT_RADIUS + 0.32;
      exits.push({ x: controlled.x - forward.x * rearDistance, z: controlled.z - forward.z * rearDistance });
      const exit = exits.find(point => !this.footBlocked(point.x, point.z));
      if (!exit) { this.message('Both doors are blocked. Move to an open space.', 3); return; }
      s.player.vehicleId = null; s.player.x = exit.x; s.player.z = exit.z;
      s.player.yaw = controlled.yaw; s.player.moving = false;
      controlled.speed = 0;
      this.message('On foot. Your car stays where you parked it.', 2.5);
      return;
    }
    if (s.mission.phase === 'available' && dist(s.player, this.world.pickup) < 4) {
      s.mission.phase = 'collect'; s.mission.elapsed = 0;
      this.message('Portside Express started. Enter the amber courier car.', 5);
      return;
    }
    const car = this.nearbyVehicle();
    if (!car) return;
    if (car.kind === 'traffic' && car.driver) {
      const sequence = planCarjacking(this.world, s, car);
      if (!sequence) { this.message('Driver’s door blocked. Approach from a clear side.', 3); return; }
      s.carjacking = sequence; car.speed = 0; car.steer = 0; s.player.moving = false;
      s.combat.reload = null; s.combat.aiming = false;
      this.message('Taking the vehicle…', sequence.duration + .5);
      return;
    }
    s.player.vehicleId = car.id; s.player.x = car.x; s.player.z = car.z; s.player.yaw = car.yaw; car.steer = 0;
    if (car.kind === 'traffic') {
      // A stopped traffic car becomes a persistent, freely usable parked car.
      car.kind = 'parked'; car.route = []; car.speed = 0;
    }
    if (car.id === MISSION_CAR_ID && s.mission.phase === 'collect') {
      s.mission.phase = 'deliver';
      this.message('Drive to the waterfront depot. Stop in the mint delivery zone.', 5);
    } else this.message('W accelerates · S brakes / reverses · Space handbrake · E exits when slow', 4);
  }

  restartMission(): void {
    const s = this.state;
    if (s.combat.dead && s.combat.respawnIn > 0) return;
    if (s.carjacking) this.cancelCarjacking();
    const missionCar = s.vehicles.find(v => v.id === MISSION_CAR_ID)!;
    // T is an explicit reset. Only reset-owned entities move; live traffic keeps running.
    s.player.vehicleId = null;
    for (const police of s.vehicles.filter(v => v.kind === 'police')) {
      police.active = false; police.speed = 0; police.route = []; police.waypoint = 0; police.blocked = 0;
    }
    s.vehicles = s.vehicles.filter(car => car.kind !== 'police' || car.id === 'police-0' || car.id === 'police-1');
    s.officers = [];
    this.officerRoutes.clear();
    this.policeDriving.clear();
    this.policeDoorReady.clear();
    this.policeVehicleMovingUntil = 0;
    const candidates = [40, 35, 45, 30, 50, 25, 55, 20, 60].map(z => ({ x: 6, z }));
    const oldPlayer = { x: s.player.x, z: s.player.z };
    const spot = candidates.find(p => !this.vehicleBlock(missionCar, p.x, p.z, Math.PI, false));
    if (spot) { missionCar.x = spot.x; missionCar.z = spot.z; missionCar.yaw = Math.PI; }
    missionCar.speed = 0; missionCar.steer = 0;
    const spawnOptions = [SPAWN, { x: 14, z: 36 }, { x: 14, z: 43 }, { x: 12, z: 33 }, { x: 15, z: 40 }];
    const spawn = spawnOptions.find(p => !this.footBlocked(p.x, p.z)) ?? oldPlayer;
    s.player.x = spawn.x; s.player.z = spawn.z; s.player.yaw = Math.PI; s.player.moving = false;
    s.mission = { phase: 'available', elapsed: 0, best: s.mission.best, deliveryHold: 0 };
    s.police = { wanted: 0, escape: 0, caught: 0, cooldown: 2, lastSeen: null, spotted: false, reinforcementTimer: 7, helicopter: null };
    this.collisionCooldown = 0;
    this.message('Fresh delivery ready. Press E at the amber beacon to start.', 5);
  }

  getHint(): string {
    if (this.state.combat.dead) return '';
    if (this.state.carjacking) return 'Taking vehicle…';
    const car = this.controlledCar();
    if (car) {
      if (this.state.mission.phase === 'deliver' && dist(car, this.world.destination) < 10) {
        if (this.state.police.wanted) return 'Lose the patrol before delivering';
        return Math.abs(car.speed) >= 1.15 ? 'SPACE · Stop inside the mint zone' : 'Hold still · Delivering package…';
      }
      return Math.abs(car.speed) <= 1.8 ? 'E · Exit vehicle' : 'SPACE · Brake   S · Brake / reverse';
    }
    if (this.state.mission.phase === 'available' && dist(this.state.player, this.world.pickup) < 4) return 'E · Start Portside Express';
    const nearby = this.nearbyVehicle();
    if (nearby) return nearby.kind === 'traffic' && nearby.driver ? 'E · Pull driver out' : nearby.id === MISSION_CAR_ID ? 'E · Enter courier car' : 'E · Enter vehicle';
    if (this.state.mission.phase === 'collect') return 'Approach the amber courier car';
    return '';
  }
}
