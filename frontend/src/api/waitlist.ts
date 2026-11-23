// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client';

/** Join the first-party waitlist. A confirmation email is sent before the address is stored as confirmed. */
export async function joinWaitlist(email: string, consentVersion: string): Promise<void> {
  await api.post('/waitlist', { email, consentVersion });
}
