// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client';

/** What the API thinks the caller is. A UI hint only; routes enforce their own roles. */
export interface Me {
  tenantId: string;
  /** Effective role: `operator` (platform), `admin`, `member`, or null (community install). */
  role: string | null;
  userId: string | null;
  keyName: string | null;
}

export function fetchMe(signal?: AbortSignal): Promise<Me> {
  return api.get<Me>('/me', signal);
}
