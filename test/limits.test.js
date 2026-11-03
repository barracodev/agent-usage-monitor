import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_STALE_MS,
  formatReset,
  isStale,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  projectClaude,
  projectCodex,
} from '../src/core/limits.js';

test('normalizeClaudeUsage maps the account rate limits', () => {
  const actual = normalizeClaudeUsage({
    five_hour: { utilization: 27, resets_at: '2026-09-05T20:30:00Z' },
    seven_day: { utilization: 18, resets_at: '2026-09-11T00:00:00Z' },
  }, 1000);
  assert.equal(actual.usedPercent, 27);
  assert.equal(actual.resetsAt, Date.parse('2026-09-05T20:30:00Z'));
  assert.equal('weekly' in actual, false);
  assert.equal(actual.fetchedAt, 1000);
});

test('normalizeClaudeUsage is fail-closed without numeric windows', () => {
  assert.equal(normalizeClaudeUsage({ five_hour: { utilization: 'mucho' } }), null);
  assert.equal(normalizeClaudeUsage(null), null);
});

test('normalizeCodexUsage maps only the primary five-hour window', () => {
  const actual = normalizeCodexUsage({ rateLimits: {
    primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1788650648 },
    secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1789237448 },
  } });
  assert.equal(actual.usedPercent, 28);
  assert.equal(actual.resetsAt, 1788650648000);
  assert.equal('weekly' in actual, false);
});

test('normalizeCodexUsage rejects a non-five-hour primary window', () => {
  assert.equal(normalizeCodexUsage({ rateLimits: {
    primary: { usedPercent: 28, windowDurationMins: 60, resetsAt: 1788650648 },
  } }), null);
});

test('normalizeCodexUsage returns null instead of inventing 0%', () => {
  assert.equal(normalizeCodexUsage({ rateLimits: {} }), null);
});

test('isStale marks missing and expired readings', () => {
  const now = Date.now();
  assert.equal(isStale(0, CLAUDE_STALE_MS, now), true);
  assert.equal(isStale(now - CLAUDE_STALE_MS - 1, CLAUDE_STALE_MS, now), true);
  assert.equal(isStale(now - 1000, CLAUDE_STALE_MS, now), false);
});

test('formatReset returns the exact local reset time in 12-hour format', () => {
  assert.equal(formatReset(new Date(2026, 8, 5, 14, 7).getTime()), '2:07pm');
  assert.equal(formatReset(new Date(2026, 8, 5, 0, 5).getTime()), '12:05am');
  assert.equal(formatReset(new Date(2026, 8, 5, 12, 0).getTime()), '12:00pm');
  assert.equal(formatReset(null), '—');
});

test('projectClaude dims old data and hides an expired window without inventing 0%', () => {
  const now = 1800000000000;
  const value = { usedPercent: 64, resetsAt: now + 60000, fetchedAt: now - CLAUDE_STALE_MS - 1 };
  const aged = projectClaude({ value, fetchedAt: value.fetchedAt }, now);
  assert.deepEqual([aged.value.usedPercent, aged.aged, aged.stale], [64, true, false]);
  assert.equal(projectClaude({ value, fetchedAt: now - 1000 }, now).aged, false);
  const reset = projectClaude({ value, fetchedAt: value.fetchedAt }, now + 60000);
  assert.deepEqual([reset.value, reset.aged, reset.stale], [null, false, true]);
  assert.equal(projectClaude({ value, fetchedAt: now, error: 'x' }, now).stale, true);
  assert.equal(projectClaude({ value: null }, now).stale, false);
});

test('projectCodex oculta una ventana vencida hasta recibir otra lectura', () => {
  const now = 1800000000000;
  const active = { value: { usedPercent: 12, resetsAt: now + 60000 }, fetchedAt: now };
  assert.deepEqual([projectCodex(active, now).value.usedPercent, projectCodex(active, now).stale], [12, false]);
  const expired = projectCodex({ ...active, value: { ...active.value, resetsAt: now } }, now);
  assert.deepEqual([expired.value, expired.stale], [null, true]);
});

test('explicit null, blank and boolean percentages are not zero', () => {
  for (const value of [null, '', ' ', false]) {
    assert.equal(normalizeClaudeUsage({ five_hour: { used_percent: value } }), null);
    assert.equal(normalizeCodexUsage({ rateLimits: { primary: { used_percent: value, windowDurationMins: 300 } } }), null);
  }
  assert.equal(normalizeClaudeUsage({ five_hour: { utilization: 0 } }).usedPercent, 0);
});
