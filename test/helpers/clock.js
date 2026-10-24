export const flush = () => new Promise(resolve => setImmediate(resolve));

export function createClock(quantum = 1) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    performance: { now: () => now },
    setTimeout(fn, ms = 0) {
      const id = ++nextId;
      timers.set(id, { fn, at: now + Math.max(quantum, Math.ceil(ms / quantum) * quantum) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const until = now + ms;
      await flush();
      while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (timer.at > until) break;
        now = timer.at;
        timers.delete(id);
        timer.fn();
        await flush();
      }
      now = until;
      await flush();
    },
  };
}
