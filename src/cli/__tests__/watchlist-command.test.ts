import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerWatchlistCommand } from '../commands/watchlist-command.js';
import type { WatchlistService } from '../../watchlist/watchlist-service.js';
import type { WatchlistEntry, WatchlistPollResult } from '../../types/watchlist.js';

function makeStubService(): WatchlistService {
  return {
    add: vi.fn().mockImplementation(
      (domain: string, notes?: string) =>
        ({
          id: 1,
          domain,
          tld: '.com',
          notes: notes ?? null,
          lastCheckedAt: null,
          lastStatus: null,
          lastStatusChange: null,
          notified: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }) as WatchlistEntry,
    ),
    remove: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
    poll: vi.fn().mockResolvedValue({
      checked: 0,
      available: 0,
      notified: 0,
      errors: 0,
    } as WatchlistPollResult),
  } as unknown as WatchlistService;
}

function buildProgram(service?: WatchlistService): Command {
  const program = new Command();
  registerWatchlistCommand(program, { watchlistService: service ?? makeStubService() });
  return program;
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  return fn()
    .finally(() => {
      process.stdout.write = original;
    })
    .then((): string => buffer);
}

function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = '';
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  return fn()
    .finally(() => {
      process.stderr.write = original;
    })
    .then((): string => buffer);
}

describe('CLI: dominus watchlist', () => {
  describe('add', () => {
    it('adds a domain to the watchlist', async () => {
      const service = makeStubService();
      const program = buildProgram(service);

      const output = await captureStdout(async () => {
        await program.parseAsync(['node', 'dominus', 'watchlist', 'add', 'example.com']);
      });

      expect(output).toContain('Added example.com to watchlist');
      expect(service.add).toHaveBeenCalledWith('example.com', undefined);
    });

    it('accepts --notes', async () => {
      const service = makeStubService();
      const program = buildProgram(service);

      await captureStdout(async () => {
        await program.parseAsync([
          'node',
          'dominus',
          'watchlist',
          'add',
          'test.io',
          '--notes',
          'interesting',
        ]);
      });

      expect(service.add).toHaveBeenCalledWith('test.io', 'interesting');
    });

    it('prints error on failure', async () => {
      const service = makeStubService();
      (service.add as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Duplicate domain');
      });
      const program = buildProgram(service);

      const output = await captureStderr(async () => {
        try {
          await program.parseAsync(['node', 'dominus', 'watchlist', 'add', 'example.com']);
        } catch {
          // process.exit is expected
        }
      });

      expect(output).toContain('Duplicate domain');
    });
  });

  describe('remove', () => {
    it('removes a domain from the watchlist', async () => {
      const service = makeStubService();
      const program = buildProgram(service);

      const output = await captureStdout(async () => {
        await program.parseAsync(['node', 'dominus', 'watchlist', 'remove', 'example.com']);
      });

      expect(output).toContain('Removed example.com from watchlist');
    });

    it('prints error for non-existing domain', async () => {
      const service = makeStubService();
      (service.remove as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const program = buildProgram(service);

      const output = await captureStderr(async () => {
        try {
          await program.parseAsync(['node', 'dominus', 'watchlist', 'remove', 'missing.com']);
        } catch {
          // process.exit is expected
        }
      });

      expect(output).toContain('not found');
    });
  });

  describe('list', () => {
    it('shows empty message when no entries', async () => {
      const output = await captureStdout(async () => {
        await buildProgram().parseAsync(['node', 'dominus', 'watchlist', 'list']);
      });

      expect(output).toContain('Watchlist is empty');
    });

    it('lists entries in a table', async () => {
      const service = makeStubService();
      (service.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { domain: 'example.com', tld: '.com', lastCheckedAt: null, lastStatus: null, notified: 0 },
      ] as unknown as WatchlistEntry[]);
      const program = buildProgram(service);

      const output = await captureStdout(async () => {
        await program.parseAsync(['node', 'dominus', 'watchlist', 'list']);
      });

      expect(output).toContain('example.com');
      expect(output).toContain('DOMAIN');
    });

    it('supports --json output', async () => {
      const service = makeStubService();
      (service.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { domain: 'example.com', tld: '.com', notified: 0 },
      ] as unknown as WatchlistEntry[]);
      const program = buildProgram(service);

      const output = await captureStdout(async () => {
        await program.parseAsync(['node', 'dominus', 'watchlist', 'list', '--json']);
      });

      expect(() => JSON.parse(output)).not.toThrow();
    });
  });

  describe('poll', () => {
    it('calls poll and prints result', async () => {
      const service = makeStubService();
      (service.poll as ReturnType<typeof vi.fn>).mockResolvedValue({
        checked: 5,
        available: 1,
        notified: 1,
        errors: 0,
      });
      const program = buildProgram(service);

      const output = await captureStdout(async () => {
        await program.parseAsync(['node', 'dominus', 'watchlist', 'poll']);
      });

      expect(output).toContain('Checked 5');
      expect(output).toContain('available: 1');
    });

    it('supports --dry-run', async () => {
      const service = makeStubService();
      const program = buildProgram(service);

      await captureStdout(async () => {
        await program.parseAsync(['node', 'dominus', 'watchlist', 'poll', '--dry-run']);
      });

      expect(service.poll).toHaveBeenCalledWith(true);
    });

    it('prints error on poll failure', async () => {
      const service = makeStubService();
      (service.poll as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('RDAP error'));
      const program = buildProgram(service);

      const output = await captureStderr(async () => {
        try {
          await program.parseAsync(['node', 'dominus', 'watchlist', 'poll']);
        } catch {
          // process.exit is expected
        }
      });

      expect(output).toContain('RDAP error');
    });
  });
});
