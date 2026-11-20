import { describe, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineRaceTests } from './approval-race.shared.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('approval claim race (SQLite, file DB, N connections)', () => {
  defineRaceTests(() => {
    const d = mkdtempSync(join(tmpdir(), 'splicedock-race-'));
    dirs.push(d);
    return join(d, 'race.db');
  });
});
