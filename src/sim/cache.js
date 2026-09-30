// Values computed one day at a time, cached on the object they belong to so
// two emulators in one process never share results.

export function perDay(obj, prop, day, build, max = 800) {
  const cache = obj[prop] || (obj[prop] = new Map());
  let v = cache.get(day);
  if (v === undefined) {
    v = build();
    if (cache.size >= max) cache.clear();
    cache.set(day, v);
  }
  return v;
}
