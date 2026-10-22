// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The decision root: the smallest set of dependencies that can answer a
// question about a domain.
//
// The regression this guards is the one a user meets first. `dominus score
// example.com` used to build the WHOLE application: it opened the SQLite
// database, applied the migrations, created a database file next to the
// user, started the job worker, waited for an Unbound resolver that a
// scoring command never asks for and printed fourteen kilobytes of JSON
// log on stdout, where the decision belongs.
//
// The decision root is the answer: an engine and a trademark gate, and
// nothing else.
import { describe, it, expect } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../config.js';
import { createDecisionDependencies } from '../decision-root.js';

describe('the decision root', () => {
  it('builds a scoring engine and a trademark gate', () => {
    const deps = createDecisionDependencies(loadConfig());
    expect(deps.engine).toBeDefined();
    expect(typeof deps.engine.score).toBe('function');
    expect(deps.gate).toBeDefined();
    expect(typeof deps.gate.check).toBe('function');
    expect(deps.currentWeights).toBeDefined();
  });

  it('does not create a database', () => {
    // The database path points at a file that does not exist. A decision
    // command that writes one is a decision command that touches the
    // user's disk - and the file is the proof.
    const dbPath = join(tmpdir(), `dominus-decision-root-${process.pid}.db`);
    rmSync(dbPath, { force: true });
    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = dbPath;
    try {
      createDecisionDependencies(loadConfig());
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
      rmSync(dbPath, { force: true });
    }
  });
});
