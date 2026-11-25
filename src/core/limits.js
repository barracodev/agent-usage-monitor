export const CLAUDE_STALE_MS = 30 * 60 * 1000;
export const CODEX_STALE_MS = 10 * 60 * 1000;

function toPercent(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalize(provider, value, fetchedAt) {
  const usedPercent = toPercent(value?.utilization ?? value?.usedPercent ?? value?.used_percent);
  if (usedPercent === null) return null;
  return { provider, usedPercent, resetsAt: toEpochMs(value?.resets_at ?? value?.resetsAt), fetchedAt };
}

export function normalizeClaudeUsage(rateLimits, fetchedAt = Date.now()) {
  const source = rateLimits?.rate_limits || rateLimits?.rateLimits || rateLimits || {};
  const session = normalize('claude', source.five_hour, fetchedAt);
  const weekly = normalize('claude', source.seven_day, fetchedAt);
  return session || weekly ? { session, weekly, fetchedAt } : null;
}

export function normalizeCodexUsage(data, fetchedAt = Date.now()) {
  const { primary, secondary } = data?.rateLimits || data?.rate_limits || {};
  const session = Number(primary?.windowDurationMins) === 300 ? normalize('codex', primary, fetchedAt) : null;
  const weekly = Number(secondary?.windowDurationMins) === 10080 ? normalize('codex', secondary, fetchedAt) : null;
  return session || weekly ? { session, weekly, fetchedAt } : null;
}

export function isStale(fetchedAt, maxAgeMs, now = Date.now()) {
  const stamp = Number(fetchedAt);
  return !Number.isFinite(stamp) || stamp <= 0 || now - stamp > maxAgeMs;
}

// Un dato viejo se atenúa; tras el reset hace falta otra lectura para conocer la ventana nueva.
export function projectClaude(entry, now = Date.now()) {
  const value = entry.value;
  if (value?.resetsAt && value.resetsAt <= now) return { ...entry, value: null, stale: true, aged: false };
  return { ...entry, fetchedAt: entry.fetchedAt || null, stale: Boolean(value && entry.error), aged: Boolean(value) && isStale(entry.fetchedAt, CLAUDE_STALE_MS, now) };
}

export function projectCodex(entry, now = Date.now()) {
  const value = entry.value;
  if (value?.resetsAt && value.resetsAt <= now) return { ...entry, value: null, stale: true };
  return { ...entry, fetchedAt: entry.fetchedAt || null, stale: Boolean(value) && (Boolean(entry.error) || isStale(entry.fetchedAt, CODEX_STALE_MS, now)) };
}

export function formatReset(resetAt, includeDay = false) {
  const stamp = Number(resetAt);
  if (!Number.isFinite(stamp) || stamp <= 0) return '—';
  // A mano y no con toLocaleTimeString: «p. m.» no cabe en la celda; «12:58am» llena sus 81 px.
  const date = new Date(stamp);
  const day = includeDay ? `${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][date.getDay()]} ` : '';
  return `${day}${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}${date.getHours() < 12 ? 'am' : 'pm'}`;
}
