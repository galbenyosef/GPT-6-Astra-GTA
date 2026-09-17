import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_LENGTH_SECONDS, DayNightCycle, solarState, TIME_SKIP_SECONDS } from '../src/game/dayNight.ts';

test('one complete day takes twelve minutes and wraps without accumulating days', () => {
  const cycle = new DayNightCycle();
  const initial = cycle.status.hour;
  assert.equal(DAY_LENGTH_SECONDS, 720);
  cycle.advance(DAY_LENGTH_SECONDS / 2);
  assert.ok(Math.abs(cycle.status.hour - 3.5) < 1e-10);
  cycle.advance(DAY_LENGTH_SECONDS / 2);
  assert.ok(Math.abs(cycle.status.hour - initial) < 1e-10);
  cycle.advance(100 * DAY_LENGTH_SECONDS);
  assert.ok(Math.abs(cycle.status.hour - initial) < 1e-10);
});

test('clock rate is independent of render frequency', () => {
  for (const fps of [30, 60, 75, 120, 144, 165]) {
    const cycle = new DayNightCycle(12);
    for (let frame = 0; frame < fps * 15; frame++) cycle.advance(1 / fps);
    assert.ok(Math.abs(cycle.status.hour - 12.5) < 1e-9);
  }
});

test('Y visits sunset, night, dawn and day with a three-second continuous transition', () => {
  const cycle = new DayNightCycle();
  for (const [phase, clock] of [['Sunset', '18:00'], ['Night', '00:00'], ['Dawn', '06:00'], ['Day', '12:00']]) {
    const before = cycle.status.hour;
    assert.equal(cycle.skipToNextPhase(), phase);
    assert.equal(cycle.status.hour, before, 'pressing Y must not snap the scene');
    assert.equal(cycle.status.transitioning, true);
    cycle.advance(TIME_SKIP_SECONDS / 2);
    assert.notEqual(cycle.status.hour, before);
    cycle.advance(TIME_SKIP_SECONDS / 2);
    assert.equal(cycle.status.clock, clock);
    assert.equal(cycle.status.phase, phase);
    assert.equal(cycle.status.transitioning, false);
  }
});

test('pause, held time and manual transitions do not advance unexpectedly', () => {
  const cycle = new DayNightCycle();
  cycle.toggleAutomatic();
  const held = cycle.status;
  cycle.advance(600);
  assert.deepEqual(cycle.status, held);
  cycle.skipToNextPhase();
  cycle.advance(1);
  const paused = cycle.status;
  for (const dt of [0, -1, NaN, Infinity]) cycle.advance(dt);
  assert.deepEqual(cycle.status, paused);
  cycle.advance(2);
  assert.equal(cycle.status.clock, '18:00');
  cycle.advance(50);
  assert.equal(cycle.status.clock, '18:00');
  assert.equal(cycle.toggleAutomatic(), true);
  cycle.advance(30);
  assert.equal(cycle.status.clock, '19:00');
});

test('rapid manual skips cross midnight without jumping backwards or losing the target', () => {
  const cycle = new DayNightCycle(23.5);
  assert.equal(cycle.skipToNextPhase(), 'Night');
  cycle.advance(.6);
  const current = cycle.status.hour;
  assert.equal(cycle.skipToNextPhase(), 'Dawn');
  assert.equal(cycle.status.hour, current);
  cycle.advance(3);
  assert.equal(cycle.status.clock, '06:00');
  for (let i = 0; i < 20; i++) cycle.skipToNextPhase();
  cycle.advance(3);
  assert.equal(cycle.status.clock, '06:00');
  assert.equal(cycle.status.transitioning, false);
});

test('sun and moon remain opposite unit directions and illumination is continuous', () => {
  let previous = solarState(0);
  for (let minute = 0; minute <= 1440; minute++) {
    const sky = solarState(minute / 60);
    assert.ok(Math.abs(Math.hypot(sky.sun.x, sky.sun.y, sky.sun.z) - 1) < 1e-12);
    assert.equal(sky.moon.x, -sky.sun.x);
    assert.equal(sky.moon.y, -sky.sun.y);
    assert.equal(sky.moon.z, -sky.sun.z);
    for (const key of ['daylight', 'night', 'twilight'] as const) {
      assert.ok(sky[key] >= 0 && sky[key] <= 1);
      assert.ok(Math.abs(sky[key] - previous[key]) < .04);
    }
    previous = sky;
  }
  assert.equal(solarState(12).daylight, 1);
  assert.equal(solarState(0).night, 1);
  assert.ok(solarState(6).twilight > .5);
  assert.deepEqual(solarState(24), solarState(0));
});

test('clock displays valid 24-hour times and handles invalid initial values', () => {
  for (const hour of [-1, 0, 23.99999999, 24, 2401, NaN, Infinity]) {
    const cycle = new DayNightCycle(hour);
    assert.match(cycle.status.clock, /^(?:[01]\d|2[0-3]):[0-5]\d$/);
    assert.ok(cycle.status.hour >= 0 && cycle.status.hour < 24);
  }
});
