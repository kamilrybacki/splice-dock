// In-memory ring buffer of policy decisions for the WebUI live feed.
// Long-term retention is Loki's job (the structured stdout logger keeps emitting).

export interface AuditEntry {
  ts: number;            // Date.now()
  tool: string;
  decision: 'allow' | 'deny' | 'approval';
  rule?: string;
  argv_len: number;          // count only; argv content is never recorded
  request_id?: string;
}

export type AuditListener = (entry: AuditEntry) => void;

export class AuditBuffer {
  private buf: AuditEntry[];
  private idx = 0;
  private size = 0;
  private listeners: AuditListener[] = [];

  constructor(private readonly capacity = 2000) {
    this.buf = new Array(capacity);
  }

  push(entry: AuditEntry): void {
    this.buf[this.idx] = entry;
    this.idx = (this.idx + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    for (const fn of this.listeners) {
      try { fn(entry); } catch { /* listener errors must not break the producer */ }
    }
  }

  /** Most recent `limit` entries, newest first. */
  recent(limit: number, opts: { tool?: string; decision?: 'allow' | 'deny' | 'approval' } = {}): AuditEntry[] {
    const out: AuditEntry[] = [];
    // Walk backwards from the most recent slot.
    let i = this.idx - 1;
    if (i < 0) i += this.capacity;
    let scanned = 0;
    while (scanned < this.size && out.length < limit) {
      const entry = this.buf[i];
      if (
        entry !== undefined &&
        (opts.tool === undefined || entry.tool === opts.tool) &&
        (opts.decision === undefined || entry.decision === opts.decision)
      ) {
        out.push(entry);
      }
      i = i - 1;
      if (i < 0) i += this.capacity;
      scanned++;
    }
    return out;
  }

  subscribe(fn: AuditListener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  get length(): number { return this.size; }
}
