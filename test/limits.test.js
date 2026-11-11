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
  assert.equal(actual.session.usedPercent, 27);
  assert.equal(actual.session.resetsAt, Date.parse('2026-09-05T20:30:00Z'));
  assert.equal(actual.weekly.usedPercent, 18);
  assert.equal(actual.weekly.resetsAt, Date.parse('2026-09-11T00:00:00Z'));
  assert.equal(actual.fetchedAt, 1000);
});

test('normalizeClaudeUsage is fail-closed without numeric windows', () => {
  assert.equal(normalizeClaudeUsage({ five_hour: { utilization: 'mucho' } }), null);
  assert.equal(normalizeClaudeUsage(null), null);
});

test('normalizeCodexUsage maps session and weekly windows', () => {
  const actual = normalizeCodexUsage({ rateLimits: {
    primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1788650648 },
    secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1789237448 },
  } });
  assert.equal(actual.session.usedPercent, 28);
  assert.equal(actual.session.resetsAt, 1788650648000);
  assert.equal(actual.weekly.usedPercent, 4);
  assert.equal(actual.weekly.resetsAt, 1789237448000);
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
  assert.equal(normalizeClaudeUsage({ five_hour: { utilization: 0 } }).session.usedPercent, 0);
});

test('cada ventana válida sobrevive aunque falte o sea inválida la otra', () => {
  for (const [normalize, wrap, sessionKey, weeklyKey] of [
    [normalizeClaudeUsage, limits => ({ rate_limits: limits }), 'five_hour', 'seven_day'],
    [normalizeCodexUsage, limits => ({ rateLimits: limits }), 'primary', 'secondary'],
  ]) {
    for (const [key, period, duration] of [[sessionKey, 'session', 300], [weeklyKey, 'weekly', 10080]]) {
      const other = period === 'session' ? 'weekly' : 'session';
      const otherKey = period === 'session' ? weeklyKey : sessionKey;
      for (const invalid of [undefined, { utilization: null }, { usedPercent: 'mucho' }]) {
        const result = normalize(wrap({ [key]: { utilization: '132', resets_at: '2026-11-12T03:59:59.911921+00:00', windowDurationMins: duration }, [otherKey]: invalid }), 1234);
        assert.equal(result[period].usedPercent, 100);
        assert.equal(result[period].resetsAt, Date.parse('2026-11-12T03:59:59.911921+00:00'));
        assert.equal(result[period].fetchedAt, 1234);
        assert.equal(result[other], null);
        assert.equal(result.fetchedAt, 1234);
      }
    }
  }
});

test('Codex solo acepta primary de 300 min y secondary de 10080 min', () => {
  const weekly = { usedPercent: 32, windowDurationMins: 10080, resetsAt: 1794423188 };
  const actual = normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 60 }, secondary: weekly } });
  assert.equal(actual.session, null);
  assert.equal(actual.weekly.usedPercent, 32);
  assert.equal(actual.weekly.resetsAt, 1794423188000);
  for (const duration of [undefined, null, 300, 10079, 10081]) {
    assert.equal(normalizeCodexUsage({ rateLimits: { secondary: { ...weekly, windowDurationMins: duration } } }), null);
  }
});

test('el reinicio semanal incluye el día local sin cambiar el formato de sesión', () => {
  const at = new Date(2026, 10, 11, 21, 59).getTime();
  assert.equal(formatReset(at, true), 'mié 9:59pm');
  assert.equal(formatReset(at), '9:59pm');
  assert.equal(formatReset(null, true), '—');
});
