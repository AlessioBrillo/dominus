// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';

export const E2E_API_KEY = 'sk-e2e-test-key';

// Authenticates through the real login form. The Layout swaps the LoginForm
// for the app shell once the key is verified; the placeholder input being
// detached is the signal that authentication succeeded.
export async function login(page: Page): Promise<void> {
  await page.goto('/');
  const input = page.getByPlaceholder('API Key');
  await input.waitFor({ state: 'visible' });
  await input.fill(E2E_API_KEY);
  await page.getByRole('button', { name: 'Authenticate' }).click();
  await page.getByPlaceholder('API Key').waitFor({ state: 'detached' });
}