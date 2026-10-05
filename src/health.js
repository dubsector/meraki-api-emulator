// Response times of recent API calls, for /healthz and the landing page.
// Uses the wall clock, since the emulator's own clock can be frozen.

const WINDOW = 300; // seconds of history the summary covers
const BUCKET = 10; // seconds per point in the timeline

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);
const round = (ms) => (ms == null ? null : Math.round(ms * 10) / 10);

export class Health {
  constructor(max = 20000) {
    this.max = max;
    this.items = [];
    this.started = Date.now();
    this.total = 0;
  }

  add(op, status, ms) {
    this.total++;
    this.items.push({ t: Date.now(), op, status, ms });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  summary(info = {}) {
    const now = Date.now();
    const recent = this.items.filter((e) => e.t > now - WINDOW * 1000);
    const times = recent.map((e) => e.ms).sort((a, b) => a - b);
    const count = (test) => recent.filter((e) => test(e.status)).length;
    const byOp = new Map();
    for (const e of recent) if (e.op) (byOp.get(e.op) ?? byOp.set(e.op, []).get(e.op)).push(e.ms);
    const mostCalled = [...byOp]
      .map(([op, ms]) => ({ op, calls: ms.length, avgMs: round(ms.reduce((a, b) => a + b, 0) / ms.length), maxMs: round(Math.max(...ms)) }))
      .sort((a, b) => b.calls - a.calls || b.avgMs - a.avgMs)
      .slice(0, 5);
    // Buckets sit on fixed clock boundaries, so a call stays in its bucket as time moves on.
    // Oldest bucket first, so the last one is the current, partly filled one.
    const n = WINDOW / BUCKET;
    const last = Math.floor(now / (BUCKET * 1000));
    const buckets = Array.from({ length: n }, () => []);
    for (const e of recent) {
      const i = n - 1 - (last - Math.floor(e.t / (BUCKET * 1000)));
      if (i >= 0) buckets[i].push(e.ms);
    }
    const timeline = buckets.map((ms, i) => ({
      start: new Date((last - (n - 1 - i)) * BUCKET * 1000).toISOString(),
      requests: ms.length,
      p95Ms: round(pct(ms.sort((a, b) => a - b), 0.95)),
    }));
    return {
      status: 'ok',
      ...info,
      uptimeSeconds: Math.round((now - this.started) / 1000),
      requests: this.total,
      window: {
        seconds: WINDOW,
        requests: recent.length,
        perMinute: round(recent.length / (WINDOW / 60)),
        p50Ms: round(pct(times, 0.5)),
        p95Ms: round(pct(times, 0.95)),
        maxMs: round(times.at(-1) ?? null),
        clientErrors: count((s) => s >= 400 && s < 500 && s !== 429),
        serverErrors: count((s) => s >= 500),
        rateLimited: count((s) => s === 429),
      },
      mostCalled,
      timeline,
    };
  }
}
