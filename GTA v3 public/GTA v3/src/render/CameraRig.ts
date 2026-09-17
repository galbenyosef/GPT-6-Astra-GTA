import * as THREE from 'three';
import type { Building, Point, Point3 } from '../game/types';

const SENSITIVITY = .0025;
const MIN_PITCH = -.12;
const MAX_PITCH = 1.25;
const GROUND_CLEARANCE = .4;
const FIRST_PERSON_PITCH = 1.4;
const DRIVER_LOOK_LIMIT = 1.9;

export interface CameraTargetOptions {
  /** Absolute world-space eye Y, including the height of the road/pavement. */
  eyeHeight?: number;
  vehicleYaw?: number;
  /** Local car X/Z; Y is the absolute eye height when eyeHeight is omitted. */
  seatOffset?: { x: number; y: number; z: number };
  /** Give approaching air support room above the street in the default chase view. */
  airSupport?: boolean;
}

export interface InteractionCameraFrame {
  eye: Point3; lookAt: Point3; thirdPosition: Point3; focus: Point3;
  /** Normalized approach progress gently frames the action from third person. */
  blend: number;
}

const wrappedYaw = (yaw: number) => Math.atan2(Math.sin(yaw), Math.cos(yaw));
const finiteOr = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;

/** Mouse owns the view direction; following and collision only move its origin. */
export class CameraRig {
  private yaw = Math.PI;
  private pitch = .42;
  private streetPitch = .42;
  private firearmPitch: number | null = null;
  private combat = false;
  private aiming = false;
  private wide = false;
  private firstPerson = false;
  private firstPersonPitch = 0;
  private driving = false;
  private vehicleYaw = 0;
  private driverLookYaw = 0;
  private airSupportLift = 0;
  private airSupportManuallyFramed = false;
  private initialized = false;
  private boomLength = 0;
  private readonly thirdPersonFov: number;
  private readonly thirdPersonNear: number;
  private readonly focus = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private interactionActive = false;
  private interactionFirst = false;
  private interactionSnap = false;
  private readonly interactionStart = new THREE.Vector3();
  private readonly interactionRotation = new THREE.Quaternion();
  private readonly interactionLook = new THREE.Vector3();
  private readonly interactionEndRotation = new THREE.Quaternion();

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly buildings: readonly Building[]) {
    this.thirdPersonFov = camera.fov;
    this.thirdPersonNear = camera.near;
  }

  look(deltaX: number, deltaY: number) {
    if (this.interactionActive) return;
    if (Number.isFinite(deltaX)) {
      // Simulation yaw zero faces +Z; decreasing yaw turns toward screen right.
      if (this.firstPerson && this.driving) {
        this.driverLookYaw = THREE.MathUtils.clamp(this.driverLookYaw - deltaX * SENSITIVITY, -DRIVER_LOOK_LIMIT, DRIVER_LOOK_LIMIT);
        this.yaw = wrappedYaw(this.vehicleYaw + this.driverLookYaw);
      } else this.yaw = wrappedYaw(this.yaw - deltaX * SENSITIVITY);
    }
    if (Number.isFinite(deltaY)) {
      if (deltaY !== 0 && this.airSupportLift > 0) {
        // Hand the currently visible pitch to the mouse without snapping back.
        this.pitch -= this.airSupportLift;
        this.airSupportLift = 0;
        this.airSupportManuallyFramed = true;
      }
      const minimum = this.firstPerson ? this.driving ? -1.1 : -FIRST_PERSON_PITCH : this.combat ? -.9 : MIN_PITCH;
      const maximum = this.firstPerson ? this.driving ? 1 : FIRST_PERSON_PITCH : MAX_PITCH;
      this.pitch = THREE.MathUtils.clamp(this.pitch + deltaY * SENSITIVITY, minimum, maximum);
    }
  }

  getMovementYaw() { return this.yaw; }

  getPitch() { return this.pitch - this.airSupportLift; }

  isFirstPerson() { return this.firstPerson; }

  togglePerspective() {
    this.airSupportLift = 0;
    if (this.firstPerson) {
      this.firstPersonPitch = this.pitch;
      this.firstPerson = false;
      this.pitch = this.combat ? this.firearmPitch ?? .02 : this.streetPitch;
    } else {
      // The street and shoulder views keep their own pitch while FPS weapons
      // share one mouse look, so equipping a gun cannot move the crosshair.
      if (this.combat) this.firearmPitch = this.pitch;
      else this.streetPitch = this.pitch;
      this.firstPerson = true;
      this.pitch = this.driving ? 0 : this.firstPersonPitch;
      if (this.driving) { this.driverLookYaw = 0; this.yaw = wrappedYaw(this.vehicleYaw); }
    }
    this.initialized = false;
    this.updateProjection();
    return this.firstPerson ? this.driving ? 'First-person driver camera' : 'First-person camera' : 'Third-person camera';
  }

  setCombat(active: boolean, aiming = false) {
    if (active) this.airSupportLift = 0;
    if (active !== this.combat) {
      if (!this.firstPerson) {
        if (active) {
          this.streetPitch = this.pitch;
          this.pitch = this.firearmPitch ?? .02;
        } else {
          this.firearmPitch = this.pitch;
          this.pitch = this.streetPitch;
        }
      }
      this.combat = active;
    }
    this.aiming = active && aiming;
    this.updateProjection();
  }

  cycleCamera() {
    if (this.firstPerson) return 'First-person camera — press V for third person';
    if (this.combat) return this.aiming ? 'Aiming camera' : 'Shoulder camera';
    this.wide = !this.wide;
    return this.wide ? 'Scenic camera' : 'Street camera';
  }

  update(target: Point, driving: boolean, speed: number, dt: number, options: CameraTargetOptions = {}) {
    this.interactionActive = false;
    const vehicleYaw = finiteOr(options.vehicleYaw, finiteOr((target as Point & { yaw?: number }).yaw, this.vehicleYaw));
    if (this.firstPerson && driving && !this.driving) {
      this.driverLookYaw = 0;
      this.pitch = 0;
    }
    this.vehicleYaw = wrappedYaw(vehicleYaw);
    this.driving = driving;
    if (!options.airSupport) this.airSupportManuallyFramed = false;
    if (this.firstPerson || this.combat) this.airSupportLift = 0;
    else {
      const lift = options.airSupport && !this.airSupportManuallyFramed ? Math.max(0, Math.min(.37, this.pitch - .05)) : 0;
      this.airSupportLift += (lift - this.airSupportLift) * (1 - Math.exp(-Math.max(0, dt) * 3));
    }
    this.updateProjection();
    if (this.firstPerson) {
      if (driving) {
        this.yaw = wrappedYaw(this.vehicleYaw + this.driverLookYaw);
        const seatX = finiteOr(options.seatOffset?.x, .36);
        const seatZ = finiteOr(options.seatOffset?.z, .05);
        this.camera.position.set(
          target.x + Math.cos(this.vehicleYaw) * seatX + Math.sin(this.vehicleYaw) * seatZ,
          finiteOr(options.eyeHeight, finiteOr(options.seatOffset?.y, 1.65)),
          target.z - Math.sin(this.vehicleYaw) * seatX + Math.cos(this.vehicleYaw) * seatZ,
        );
      } else this.camera.position.set(target.x, finiteOr(options.eyeHeight, 2.05), target.z);
      // Exact attachment also applies to dt=0 aim preparation, teleports,
      // entry/exit and V toggles. The third-person boom never affects FPS.
      this.camera.rotation.set(-this.pitch, this.yaw + Math.PI, 0, 'YXZ');
      this.camera.updateMatrixWorld();
      return;
    }
    // Aim-ray preparation may update the view at dt=0 before a simulation step.
    const follow = 1 - Math.exp(-Math.max(dt, 0) * (this.combat ? 14 : 7));
    this.anchor.set(target.x, driving ? 1.65 : 1.6, target.z);
    // The driving target is already interpolated at render time. Attach the
    // pivot to that same pose; another follow filter makes the car slide and
    // shake relative to the camera when frame durations vary.
    if (driving || !this.initialized) this.focus.copy(this.anchor);
    else this.focus.lerp(this.anchor, follow);
    // The smoothed follow pivot must not lag through the corner of a building.
    const focusFraction = this.cameraFraction(this.anchor, this.focus, .25);
    if (focusFraction < 1) this.focus.lerpVectors(this.anchor, this.focus, Math.max(0, focusFraction - .015));

    let distance = this.combat ? this.aiming ? 3 : 4.5 : this.wide ? 46 : driving ? 25 + Math.abs(speed) * .09 : 23;
    const shoulder = this.combat ? this.aiming ? .48 : .7 : 0;
    const viewPitch = this.pitch - this.airSupportLift;
    this.offset.set(
      -Math.sin(this.yaw) * Math.cos(viewPitch) * distance - Math.cos(this.yaw) * shoulder,
      Math.sin(viewPitch) * distance,
      -Math.cos(this.yaw) * Math.cos(viewPitch) * distance + Math.sin(this.yaw) * shoulder,
    );
    distance = this.offset.length();
    this.offset.normalize();
    // Looking slightly upward is allowed without pushing the camera under the road.
    if (this.offset.y < 0) distance = Math.min(distance, (this.focus.y - GROUND_CLEARANCE) / -this.offset.y);
    this.desired.copy(this.focus).addScaledVector(this.offset, distance);
    const fraction = this.cameraFraction(this.focus, this.desired);
    const safeDistance = fraction < 1 ? Math.max(0, distance * fraction - .08) : distance;
    // Retract immediately at walls; ease outward after the obstruction clears.
    // Smoothing a position or selecting another angle would change W's direction.
    if (!this.initialized || safeDistance < this.boomLength) this.boomLength = safeDistance;
    else this.boomLength += (safeDistance - this.boomLength) * follow;
    this.camera.position.copy(this.focus).addScaledVector(this.offset, this.boomLength);
    // Explicit orientation also remains defined when a wall leaves a zero-length boom.
    this.camera.rotation.set(-viewPitch, this.yaw + Math.PI, 0, 'YXZ');
    this.initialized = true;
  }

  /** The same eye/hand action is framed from outside or seen through the actor's eyes. */
  updateInteraction(frame: InteractionCameraFrame) {
    this.airSupportLift = 0;
    const changedView = this.interactionActive && this.interactionFirst !== this.firstPerson;
    if (!this.interactionActive || changedView) {
      this.interactionStart.copy(this.camera.position);
      this.interactionRotation.copy(this.camera.quaternion);
      this.interactionSnap = changedView;
    }
    this.interactionActive = true;
    this.interactionFirst = this.firstPerson;
    this.combat = false; this.aiming = false;
    this.updateProjection();
    const blend = this.firstPerson || this.interactionSnap ? 1 : THREE.MathUtils.smoothstep(frame.blend, 0, 1);
    if (this.firstPerson) {
      this.camera.position.set(frame.eye.x, frame.eye.y, frame.eye.z);
      this.interactionLook.set(frame.lookAt.x, frame.lookAt.y, frame.lookAt.z);
    } else {
      this.focus.set(frame.focus.x, frame.focus.y, frame.focus.z);
      this.desired.set(frame.thirdPosition.x, Math.max(GROUND_CLEARANCE, frame.thirdPosition.y), frame.thirdPosition.z);
      const fraction = this.cameraFraction(this.focus, this.desired);
      this.desired.lerpVectors(this.focus, this.desired, Math.max(0, fraction - .01));
      this.camera.position.lerpVectors(this.interactionStart, this.desired, blend);
      const transitionFraction = this.cameraFraction(this.focus, this.camera.position);
      if (transitionFraction < 1) this.camera.position.lerpVectors(this.focus, this.camera.position, Math.max(0, transitionFraction - .01));
      this.interactionLook.copy(this.focus);
    }
    this.camera.lookAt(this.interactionLook);
    this.interactionEndRotation.copy(this.camera.quaternion);
    if (!this.firstPerson) this.camera.quaternion.slerpQuaternions(this.interactionRotation, this.interactionEndRotation, blend);
    const direction = this.interactionLook.sub(this.camera.position).normalize();
    this.yaw = wrappedYaw(Math.atan2(direction.x, direction.z));
    this.pitch = -Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
    // Seed the normal following rig with this pose for a smooth handover at the end.
    this.boomLength = this.camera.position.distanceTo(this.focus);
    this.initialized = true;
    this.camera.updateMatrixWorld();
  }

  private updateProjection() {
    const near = this.firstPerson ? .035 : this.thirdPersonNear;
    const fov = this.firstPerson ? this.aiming ? 58 : this.driving ? 72 : 75 : this.thirdPersonFov;
    if (this.camera.near !== near || this.camera.fov !== fov) {
      this.camera.near = near;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** First intersection along a camera segment with the authoritative city. */
  private cameraFraction(start: THREE.Vector3, end: THREE.Vector3, margin = .18) {
    let fraction = 1;
    for (const b of this.buildings) {
      let enter = 0, leave = 1;
      for (const axis of ['x', 'z', 'y'] as const) {
        const min = axis === 'x' ? b.x - b.width / 2 - margin : axis === 'z' ? b.z - b.depth / 2 - margin : -.5;
        const max = axis === 'x' ? b.x + b.width / 2 + margin : axis === 'z' ? b.z + b.depth / 2 + margin : b.height + 1.2;
        const delta = end[axis] - start[axis];
        if (Math.abs(delta) < 1e-7) { if (start[axis] < min || start[axis] > max) { enter = 2; break; } }
        else {
          let a = (min - start[axis]) / delta, c = (max - start[axis]) / delta;
          if (a > c) [a, c] = [c, a];
          enter = Math.max(enter, a); leave = Math.min(leave, c);
        }
      }
      if (enter < leave && leave > 0 && enter < fraction) fraction = Math.max(0, enter);
    }
    return fraction;
  }
}
