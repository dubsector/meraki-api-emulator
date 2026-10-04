// Epoch-seconds helpers and a cached IANA time zone offset lookup.

export const MIN = 60;
export const HOUR = 3600;
export const DAY = 86400;

export class Zone {
  constructor(tz) {
    this.tz = tz;
    this.cache = new Map();
    this.fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  }

  // UTC offset in seconds. DST changes land on UTC hour boundaries, so cache per hour.
  offset(t) {
    const h = Math.floor(t / HOUR);
    let v = this.cache.get(h);
    if (v === undefined) {
      const p = {};
      for (const part of this.fmt.formatToParts(new Date(h * HOUR * 1000))) p[part.type] = Number(part.value);
      v = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - h * HOUR;
      if (this.cache.size > 50000) this.cache.clear();
      this.cache.set(h, v);
    }
    return v;
  }

  day(t) {
    return Math.floor((t + this.offset(t)) / DAY);
  }

  midnight(day) {
    const base = day * DAY;
    return base - this.offset(base - this.offset(base));
  }

  hourOf(t) {
    return (((t + this.offset(t)) % DAY) + DAY) % DAY / HOUR;
  }
}

// 0 = Sunday. Epoch day 0 was a Thursday.
export function weekday(day) {
  return (((day + 4) % 7) + 7) % 7;
}

// Heavy reads format hundreds of thousands of timestamps in order, so the date
// part of the last day asked for is kept and the time of day is put together
// by hand. Years outside 0000 to 9999 take the slow path like before.
const TWO = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
let lastDay = NaN;
let lastDate = '';

export function iso(t) {
  const s = Math.floor(t);
  if (!(s >= -62167219200 && s < 253402300800)) return new Date(s * 1000).toISOString().slice(0, 19) + 'Z';
  const day = Math.floor(s / DAY);
  if (day !== lastDay) {
    lastDate = new Date(day * DAY * 1000).toISOString().slice(0, 11);
    lastDay = day;
  }
  const r = s - day * DAY;
  return `${lastDate}${TWO[Math.floor(r / HOUR)]}:${TWO[Math.floor((r % HOUR) / MIN)]}:${TWO[r % MIN]}Z`;
}

// Microsecond precision, the format Meraki uses on event timestamps.
export function isoMicro(t) {
  const whole = Math.floor(t);
  const micros = Math.floor((t - whole) * 1e6);
  return iso(whole).slice(0, 19) + '.' + String(micros).padStart(6, '0') + 'Z';
}

export function parseTime(v) {
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? NaN : ms / 1000;
}

// Integer microseconds, used for exact event cursors.
export function isoUs(us) {
  const s = Math.floor(us / 1e6);
  return iso(s).slice(0, 19) + '.' + String(us - s * 1e6).padStart(6, '0') + 'Z';
}

// Parses an event cursor (ISO with up to 6 fractional digits, or epoch seconds) to microseconds.
export function parseUs(v) {
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1e6);
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)?$/.exec(v);
  if (!m) return NaN;
  const ms = Date.parse(m[1] + (m[3] || 'Z'));
  return Number.isNaN(ms) ? NaN : ms * 1000 + Number((m[2] || '').padEnd(6, '0').slice(0, 6));
}
