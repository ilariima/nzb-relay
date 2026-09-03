import { randomUUID } from 'node:crypto';

export class AuditLog {
  constructor(limit = 200) {
    this.limit = limit;
    this.entries = [];
  }

  add(entry) {
    this.entries.unshift({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry
    });
    this.entries.length = Math.min(this.entries.length, this.limit);
  }

  list() {
    return structuredClone(this.entries);
  }
}
