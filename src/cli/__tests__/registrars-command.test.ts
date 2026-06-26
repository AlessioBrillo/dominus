import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerRegistrarsCommand } from '../commands/registrars-command.js';

function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  let buffer = '';
  let errBuffer = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    errBuffer += s;
    return true;
  };
  return Promise.resolve(fn())
    .finally(() => {
      process.stdout.write = originalWrite;
      process.stderr.write = originalStderr;
    })
    .then((): string => buffer + (errBuffer ? '\nSTDERR:\n' + errBuffer : ''));
}

describe('CLI: dominus registrars list', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prints all registrars in table format', async () => {
    const program = new Command();
    registerRegistrarsCommand(program, { activeRegistrar: 'manual' });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'registrars', 'list']);
    });

    expect(out).toContain('Active registrar: manual');
    expect(out).toContain('Available registrars');
    expect(out).toContain('Manual');
  });

  it('emits JSON with --json', async () => {
    const program = new Command();
    registerRegistrarsCommand(program, { activeRegistrar: 'manual' });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'registrars', 'list', '--json']);
    });

    const parsed = JSON.parse(out);
    expect(parsed.active).toBe('manual');
    expect(parsed.registrars.length).toBeGreaterThanOrEqual(1);
  });
});

describe('CLI: dominus registrars show', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows active registrar when no name given', async () => {
    const program = new Command();
    registerRegistrarsCommand(program, { activeRegistrar: 'manual' });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'registrars', 'show']);
    });

    expect(out).toContain('Manual');
  });

  it('shows a specific registrar by name', async () => {
    const program = new Command();
    registerRegistrarsCommand(program, { activeRegistrar: 'manual' });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'registrars', 'show', 'manual']);
    });

    expect(out).toContain('Manual');
  });

  it('shows JSON output with --json', async () => {
    const program = new Command();
    registerRegistrarsCommand(program, { activeRegistrar: 'manual' });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'registrars', 'show', 'manual', '--json']);
    });

    const parsed = JSON.parse(out);
    expect(parsed.name).toBe('manual');
    expect(parsed.configFields).toBeDefined();
  });

  it('exits with error for unknown registrar', async () => {
    const program = new Command();
    registerRegistrarsCommand(program, { activeRegistrar: 'manual' });

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'registrars', 'show', 'nonexistent']);
    });

    expect(out).toContain('Unknown registrar');
    expect(exitMock).toHaveBeenCalledWith(1);
    exitMock.mockRestore();
  });
});
