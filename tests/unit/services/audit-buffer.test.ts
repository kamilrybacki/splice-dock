import { describe, it, expect } from 'vitest';
import { AuditBuffer, type AuditEntry } from '../../../src/application/audit/audit-buffer.js';

function mk(tool: string, decision: 'allow' | 'deny', extras: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: Date.now(),
    tool,
    decision,
    argv_len: 2,
    ...extras,
  };
}

describe('AuditBuffer', () => {
  it('recent returns newest first', () => {
    const buf = new AuditBuffer(10);
    buf.push(mk('a', 'allow'));
    buf.push(mk('b', 'deny'));
    buf.push(mk('c', 'allow'));
    const out = buf.recent(10);
    expect(out.map(e => e.tool)).toEqual(['c', 'b', 'a']);
  });

  it('respects the capacity and drops oldest', () => {
    const buf = new AuditBuffer(3);
    buf.push(mk('a', 'allow'));
    buf.push(mk('b', 'allow'));
    buf.push(mk('c', 'allow'));
    buf.push(mk('d', 'allow'));
    expect(buf.length).toBe(3);
    const out = buf.recent(10);
    expect(out.map(e => e.tool)).toEqual(['d', 'c', 'b']);
  });

  it('filters by tool and decision', () => {
    const buf = new AuditBuffer(10);
    buf.push(mk('a', 'allow'));
    buf.push(mk('b', 'deny', { rule: 'deny_subcommands' }));
    buf.push(mk('a', 'deny', { rule: 'allow_subcommands' }));
    buf.push(mk('b', 'allow'));
    expect(buf.recent(10, { tool: 'a' }).length).toBe(2);
    expect(buf.recent(10, { decision: 'deny' }).length).toBe(2);
    expect(buf.recent(10, { tool: 'a', decision: 'deny' }).length).toBe(1);
  });

  it('limit caps the output count', () => {
    const buf = new AuditBuffer(10);
    for (let i = 0; i < 5; i++) buf.push(mk(`t${i}`, 'allow'));
    expect(buf.recent(3).length).toBe(3);
  });

  it('subscribers receive every push', () => {
    const buf = new AuditBuffer(10);
    const seen: string[] = [];
    const unsubscribe = buf.subscribe(e => seen.push(e.tool));
    buf.push(mk('a', 'allow'));
    buf.push(mk('b', 'deny'));
    unsubscribe();
    buf.push(mk('c', 'allow'));
    expect(seen).toEqual(['a', 'b']);
  });

  it('listener errors do not block producers', () => {
    const buf = new AuditBuffer(10);
    buf.subscribe(() => { throw new Error('boom'); });
    expect(() => buf.push(mk('a', 'allow'))).not.toThrow();
    expect(buf.length).toBe(1);
  });

  it('survives empty buffer reads', () => {
    const buf = new AuditBuffer(10);
    expect(buf.recent(5)).toEqual([]);
  });
});
