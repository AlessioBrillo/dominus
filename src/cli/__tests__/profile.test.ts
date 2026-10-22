// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The CLI profile.
//
// The profile decides how much of the application a command builds. It is
// resolved from the command line BEFORE the dependencies exist, because
// building them is the expensive part.
import { describe, it, expect } from 'vitest';
import { resolveCliProfile, resolveCliCommand, DECISION_COMMANDS } from '../profile.js';

describe('the CLI profile', () => {
  it('names the command the invocation asks for', () => {
    expect(resolveCliCommand(['node', 'dominus', 'score', 'example.com'])).toBe('score');
    expect(resolveCliCommand(['node', 'dominus', '--help'])).toBeUndefined();
  });

  it('sends a decision command to the decision profile', () => {
    expect(resolveCliProfile(['node', 'dominus', 'score', 'example.com'])).toBe('decision');
  });

  it('sends a decision command with options to the decision profile', () => {
    expect(resolveCliProfile(['node', 'dominus', 'score', '--closeout', 'example.com'])).toBe(
      'decision',
    );
    expect(resolveCliProfile(['node', 'dominus', 'score', '--', '-bad.com'])).toBe('decision');
  });

  it('sends every other command to the full profile', () => {
    expect(resolveCliProfile(['node', 'dominus', 'run', '--sync'])).toBe('full');
    expect(resolveCliProfile(['node', 'dominus', 'portfolio', 'list'])).toBe('full');
    expect(resolveCliProfile(['node', 'dominus', 'keys', 'create'])).toBe('full');
  });

  it('sends the invocations without a command to the catalog profile', () => {
    // --help, --version and a bare `dominus` print the command line and
    // nothing else: they must not cost an application.
    expect(resolveCliProfile(['node', 'dominus'])).toBe('catalog');
    expect(resolveCliProfile(['node', 'dominus', '--help'])).toBe('catalog');
    expect(resolveCliProfile(['node', 'dominus', '--version'])).toBe('catalog');
  });

  it('keeps the decision commands free of persistence', () => {
    // A command that writes a result down is not a decision command: the
    // record is the point of it.
    for (const command of DECISION_COMMANDS) {
      expect(['score']).toContain(command);
    }
  });
});
