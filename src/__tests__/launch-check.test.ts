// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', '..', 'scripts', 'launch-check.mjs');

/**
 * The launch gate must be executable and it must fail.
 *
 * A launch gate that always passes is a rubber stamp; one that cannot be
 * run is a document. These tests run the real script and assert both the
 * failure and the success path.
 */
function runGate(
  env: Record<string, string | undefined>,
  args: string[] = ['--cloud'],
): {
  status: number | null;
  output: string;
} {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf-8',
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const COMPLETE_ENV = {
  LEGAL_ENTITY_NAME: 'Example Operator SRL',
  LEGAL_ENTITY_KIND: 'company',
  LEGAL_REGISTERED_ADDRESS: 'Via Roma 1, 00100 Roma (RM), Italy',
  LEGAL_VAT_ID: 'IT12345678901',
  LEGAL_REGISTRO_IMPRESE: 'Registro Imprese di Roma',
  LEGAL_REA_NUMBER: 'RM-123456',
  LEGAL_PEC: 'example@pec.it',
  LEGAL_CONTACT_EMAIL: 'hello@example.it',
  LEGAL_PRIVACY_EMAIL: 'privacy@example.it',
  METRICS_TOKEN: 'metrics-token-value',
  BACKUP_DIR: '/var/backups/dominus',
  BACKUP_RETENTION_DAYS: '30',
};

describe('launch-check', () => {
  it('fails when a registered business omits a required register field', () => {
    const { status, output } = runGate({ ...COMPLETE_ENV, LEGAL_REA_NUMBER: undefined });

    expect(status).toBe(1);
    expect(output).toContain('legal identity');
    expect(output).toContain('LEGAL_REA_NUMBER');
  });

  it('fails when a natural person is put behind a paid service', () => {
    const { status, output } = runGate(
      {
        ...COMPLETE_ENV,
        LEGAL_ENTITY_KIND: 'individual',
        LEGAL_VAT_ID: undefined,
        LEGAL_REGISTRO_IMPRESE: undefined,
        LEGAL_REA_NUMBER: undefined,
        LEGAL_PEC: undefined,
        CLOUD_PAID_ENABLED: 'true',
      },
      ['--cloud'],
    );

    expect(status).toBe(1);
    expect(output).toContain('cannot sell a paid subscription');
  });

  it('fails when a placeholder is left in the identity', () => {
    const { status, output } = runGate({
      ...COMPLETE_ENV,
      LEGAL_PRIVACY_EMAIL: 'privacy@dominus.example',
    });

    expect(status).toBe(1);
    expect(output).toContain('legal identity');
  });

  it('fails when the backups are not configured', () => {
    const { status, output } = runGate({ ...COMPLETE_ENV, BACKUP_DIR: undefined });

    expect(status).toBe(1);
    expect(output).toContain('backups');
  });

  it('fails when the metrics token is missing', () => {
    const { status, output } = runGate({ ...COMPLETE_ENV, METRICS_TOKEN: undefined });

    expect(status).toBe(1);
    expect(output).toContain('metrics access control');
  });

  it('passes when every required check is satisfied', () => {
    const { status, output } = runGate(COMPLETE_ENV);

    expect(output).toContain('legal identity: the project identity is complete');
    expect(status).toBe(0);
  });

  it('warns about the third-party audit without failing the free launch', () => {
    const { status, output } = runGate(COMPLETE_ENV);

    expect(output).toContain('security audit');
    expect(status).toBe(0);
  });
});
