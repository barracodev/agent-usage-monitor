export function meterTone(percent) {
  if (!Number.isFinite(percent)) return 'unknown';
  if (percent >= 100) return 'danger';
  if (percent >= 80) return 'warn';
  return 'good';
}

export function providerState(entry) {
  if (!Number.isFinite(entry?.value?.usedPercent)) return { key: 'unknown' };
  if (entry.stale || entry.error) return { key: 'stale' };
  return { key: entry.aged ? 'aged' : 'live' };
}

export function formatAge(at, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 60 ? `hace ${minutes} min` : `hace ${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

export function formatCountdown(resetAt, now = Date.now(), includeDays = false) {
  if (!Number.isFinite(resetAt) || resetAt <= 0) return '—';
  const minutes = Math.max(0, Math.ceil((resetAt - now) / 60000));
  if (includeDays && minutes > 24 * 60) {
    const hours = Math.ceil(minutes / 60);
    return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  }
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

// Una cuota en 0 % todavía no tiene una ventana activa, aunque el proveedor anuncie una fecha.
export function activeResetAt(entry, now = Date.now()) {
  const used = entry?.value?.usedPercent;
  const reset = entry?.value?.resetsAt;
  return Number.isFinite(used) && used > 0 && Number.isFinite(reset) && reset > now ? reset : null;
}
