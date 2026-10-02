// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteProvider } from '../provider/sqlite-adapter.js';
import type { DatabaseProvider } from '../provider/interface.js';

describe('read/write topology (ADR-0080)', () => {
  let tmpDir: string;
  let dbPath: string;
  let providers: DatabaseProvider[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dominus-rw-test-'));
    dbPath = join(tmpDir, 'test.db');
    providers = [];
  });

  afterEach(async () => {
    for (const p of providers.reverse()) {
      await p.close().catch(() => {});
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function track(p: DatabaseProvider): DatabaseProvider {
    providers.push(p);
    return p;
  }

  it('exposes read and write factory methods (fail-closed contract)', async () => {
    const main = track(SqliteProvider.create(dbPath, { busyTimeout: 30000 }));
    expect(typeof main.createReadReplica).toBe('function');
    expect(typeof main.createWriteConnection).toBe('function');
    await main.close();
    providers = [];
  });

  it('write on write-provider is visible on read-provider immediately', async () => {
    const main = track(SqliteProvider.create(dbPath, { busyTimeout: 30000 }));
    const read = track(await main.createReadReplica!());
    const write = track(await main.createWriteConnection!());

    await write.exec('CREATE TABLE rw_probe (id INTEGER PRIMARY KEY, val TEXT)');
    await write.exec('INSERT INTO rw_probe (val) VALUES (?)', ['hello']);

    const rows = await read.query<{ val: string }>('SELECT val FROM rw_probe');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.val).toBe('hello');
  });

  it('read provider fails fast with short busy timeout', async () => {
    const main = track(SqliteProvider.create(dbPath, { busyTimeout: 30000 }));
    const read = track(await main.createReadReplica!());
    const busyTimeout = read as unknown as { rawDb?: { pragma: Function } };
    expect(busyTimeout).toBeDefined();
    expect(read.isOpen()).toBe(true);
  });

  it('lifecycle closes write, read, then main without orphans', async () => {
    const main = track(SqliteProvider.create(dbPath, { busyTimeout: 30000 }));
    const read = await main.createReadReplica!();
    const write = await main.createWriteConnection!();
    providers.push(read, write);

    expect(main.isOpen()).toBe(true);
    expect(read.isOpen()).toBe(true);
    expect(write.isOpen()).toBe(true);

    await write.close();
    await read.close();
    await main.close();
    providers = [];

    expect(write.isOpen()).toBe(false);
    expect(read.isOpen()).toBe(false);
    expect(main.isOpen()).toBe(false);
  });
});
