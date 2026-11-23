// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client';

/** Join the first-party waitlist. The consent version is taken from the published documents server-side. */
export async function joinWaitlist(email: string): Promise<void> {
  await api.post('/waitlist', { email });
}
