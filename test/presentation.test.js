import test from 'node:test';
import assert from 'node:assert/strict';
import { activeResetAt, meterTone, providerState, formatAge, formatCountdown } from '../src/core/presentation.js';

test('meterTone uses 80 and 100 percent thresholds', () => {
  for (const [value, tone] of [[0, 'good'], [79.9, 'good'], [80, 'warn'], [99.9, 'warn'], [100, 'danger'], [null, 'unknown']]) assert.equal(meterTone(value), tone);
});

test('missing, stale and failed refreshes never look live', () => {
  const value = { usedPercent: 20 };
  assert.equal(providerState({ value }).key, 'live');
  assert.equal(providerState({ value, stale: true }).key, 'stale');
  assert.equal(providerState({ value, error: 'read failed', stale: false }).key, 'stale');
  assert.equal(providerState({ value: { usedPercent: null } }).key, 'unknown');
  assert.equal(providerState({ value: null }).key, 'unknown');
  assert.equal(providerState({ value, aged: true }).key, 'aged');
  assert.equal(providerState({ value, aged: true, stale: true }).key, 'stale');
});

test('age reads in minutes, then hours', () => {
  const now = 1800000000000;
  assert.equal(formatAge(now - 42 * 60000, now), 'hace 42 min');
  assert.equal(formatAge(now - 125 * 60000, now), 'hace 2 h 5 m');
});

test('countdown follows reset time, rounds up minutes and never goes negative', () => {
  const now = 1800000000000;
  assert.equal(formatCountdown(now + 134 * 60000, now), '2 h 14 m');
  assert.equal(formatCountdown(now + 1, now), '0 h 1 m');
  assert.equal(formatCountdown(now - 1, now), '0 h 0 m');
  assert.equal(formatCountdown(null, now), '—');
  assert.equal(formatCountdown(now + 24 * 3600000, now), '24 h 0 m');
  assert.equal(formatCountdown(now + 24 * 3600000 + 1, now), '24 h 1 m');
  assert.equal(formatCountdown(now + 24 * 3600000, now, true), '24 h 0 m');
  assert.equal(formatCountdown(now + 24 * 3600000 + 1, now, true), '1 d 1 h');
  assert.equal(formatCountdown(now + 51 * 3600000, now, true), '2 d 3 h');
});

test('a reset solo existe mientras hay consumo y la ventana sigue activa', () => {
  const now = 1800000000000;
  assert.equal(activeResetAt({ value: { usedPercent: 12, resetsAt: now + 60000 } }, now), now + 60000);
  assert.equal(activeResetAt({ value: { usedPercent: 0, resetsAt: now + 60000 } }, now), null);
  assert.equal(activeResetAt({ value: { usedPercent: 12, resetsAt: now - 1 } }, now), null);
  assert.equal(activeResetAt({ value: { usedPercent: 12, resetsAt: null } }, now), null);
});

test('una ventana fija admite cero solo con una lectura válida y un reset futuro', () => {
  const now = 1800000000000;
  const entry = { value: { usedPercent: 0, resetsAt: now + 60000 } };
  assert.equal(activeResetAt(entry, now, true), now + 60000);
  for (const usedPercent of [null, undefined, NaN, -1]) {
    assert.equal(activeResetAt({ value: { ...entry.value, usedPercent } }, now, true), null);
  }
  for (const resetsAt of [null, undefined, NaN, now, now - 1]) {
    assert.equal(activeResetAt({ value: { ...entry.value, resetsAt } }, now, true), null);
  }
});
