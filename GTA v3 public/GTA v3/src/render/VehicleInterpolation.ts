import type { GameState, Vehicle } from '../game/types';

type Pose = Pick<Vehicle, 'x' | 'z' | 'yaw' | 'speed' | 'steer' | 'active'>;

/** Keep physics authoritative; only displayed poses are one fixed step behind. */
export class VehicleInterpolation {
  private readonly previous = new Map<string, Pose>();
  private controlledId: string | null = null;

  /** Capture before EVERY fixed step, including multiple steps in one frame. */
  capture(state: GameState) {
    this.controlledId = state.player.vehicleId;
    const ids = new Set<string>();
    for (const vehicle of state.vehicles) {
      ids.add(vehicle.id);
      const pose = this.previous.get(vehicle.id) ?? {} as Pose;
      pose.x = vehicle.x; pose.z = vehicle.z; pose.yaw = vehicle.yaw;
      pose.speed = vehicle.speed; pose.steer = vehicle.steer; pose.active = vehicle.active;
      this.previous.set(vehicle.id, pose);
    }
    for (const id of this.previous.keys()) if (!ids.has(id)) this.previous.delete(id);
  }

  sample(state: GameState, alpha: number): Vehicle[] {
    const blend = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    return state.vehicles.map(vehicle => {
      const before = this.previous.get(vehicle.id);
      // Spawns, respawns and entry actions must appear at their actual location.
      if (!before || !before.active || !vehicle.active || blend === 1 ||
          state.carjacking?.vehicleId === vehicle.id ||
          this.controlledId !== state.player.vehicleId ||
          Math.hypot(vehicle.x - before.x, vehicle.z - before.z) > 4) return vehicle;
      const yawDelta = Math.atan2(Math.sin(vehicle.yaw - before.yaw), Math.cos(vehicle.yaw - before.yaw));
      return {
        ...vehicle,
        x: before.x + (vehicle.x - before.x) * blend,
        z: before.z + (vehicle.z - before.z) * blend,
        yaw: before.yaw + yawDelta * blend,
        speed: before.speed + (vehicle.speed - before.speed) * blend,
        steer: before.steer + (vehicle.steer - before.steer) * blend,
      };
    });
  }
}
