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

export function iso(t) {
  return new Date(Math.floor(t) * 1000).toISOString().slice(0, 19) + 'Z';
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
