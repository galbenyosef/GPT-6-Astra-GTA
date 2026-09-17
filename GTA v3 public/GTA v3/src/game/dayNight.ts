export const DAY_LENGTH_SECONDS = 12 * 60;
export const TIME_SKIP_SECONDS = 3;
export const START_HOUR = 15.5;
const TAU = Math.PI * 2;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (low: number, high: number, value: number) => {
  const t = clamp((value - low) / (high - low));
  return t * t * (3 - 2 * t);
};
export const wrapHour = (hour: number) => ((hour % 24) + 24) % 24;
export type DayPhase = 'Dawn' | 'Day' | 'Sunset' | 'Night';
export interface DayNightStatus {
  hour: number; clock: string; phase: DayPhase; automatic: boolean; transitioning: boolean;
}

export function solarState(hour: number) {
  const angle = (wrapHour(Number.isFinite(hour) ? hour : START_HOUR) - 6) / 24 * TAU;
  const sun = { x: Math.cos(angle), y: Math.sin(angle) * .88, z: Math.sin(angle) * Math.sqrt(1 - .88 ** 2) };
  const daylight = smooth(-.13, .25, sun.y);
  const night = 1 - smooth(-.2, .03, sun.y);
  const twilight = (1 - smooth(.04, .4, Math.abs(sun.y))) * (1 - night * .65);
  return { sun, moon: { x: -sun.x, y: -sun.y, z: -sun.z }, daylight, night, twilight };
}

/** The sky clock is independent of mission, combat and physics timers. */
export class DayNightCycle {
  private hours: number;
  private automatic = true;
  private transition: { from: number; to: number; elapsed: number } | null = null;

  constructor(hour = START_HOUR) { this.hours = wrapHour(Number.isFinite(hour) ? hour : START_HOUR); }

  advance(dt: number) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (this.transition) {
      const remaining = TIME_SKIP_SECONDS - this.transition.elapsed;
      const used = Math.min(dt, remaining);
      this.transition.elapsed += used;
      const t = smooth(0, TIME_SKIP_SECONDS, this.transition.elapsed);
      this.hours = this.transition.from + (this.transition.to - this.transition.from) * t;
      if (this.transition.elapsed >= TIME_SKIP_SECONDS) {
        this.hours = wrapHour(this.transition.to);
        this.transition = null;
        if (dt > used) this.advance(dt - used);
      }
    } else if (this.automatic) this.hours = wrapHour(this.hours + dt * 24 / DAY_LENGTH_SECONDS);
  }

  toggleAutomatic() { this.automatic = !this.automatic; return this.automatic; }

  skipToNextPhase(): DayPhase {
    // Repeated presses deliberately move to the next destination, without
    // discontinuities or a reverse sweep when the clock crosses midnight.
    const from = this.hours;
    const reference = this.transition?.to ?? from;
    const to = (Math.floor((reference + 1e-8) / 6) + 1) * 6;
    this.transition = { from, to, elapsed: 0 };
    return this.phase(wrapHour(to));
  }

  private phase(hour: number): DayPhase {
    return hour >= 5 && hour < 7.5 ? 'Dawn' : hour >= 7.5 && hour < 17 ? 'Day' : hour >= 17 && hour < 19.5 ? 'Sunset' : 'Night';
  }

  get status(): DayNightStatus {
    const hour = wrapHour(this.hours);
    const minutes = Math.floor(hour * 60 + 1e-7) % 1440;
    return { hour, clock: `${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`,
      phase: this.phase(hour), automatic: this.automatic, transitioning: this.transition !== null };
  }
}
