// Every authenticated API call, kept in memory for the apiRequests endpoints.
// A ring buffer, so a long-running emulator never holds more than `max` calls.

export class ApiLog {
  constructor(max = 10000) {
    this.max = max;
    this.items = [];
    this.seq = 0;
  }

  add(entry) {
    this.items.push({ ...entry, seq: ++this.seq });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  // Calls that touched the organization, plus calls that belong to none (like
  // GET /organizations), oldest first.
  forOrg(orgId, t0, t1) {
    return this.items.filter((e) => (e.orgId == null || e.orgId === orgId) && e.ts >= t0 && e.ts <= t1);
  }
}
