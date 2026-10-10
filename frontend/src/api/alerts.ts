// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client';

export async function acknowledgeAlert(id: number): Promise<void> {
  await api.post(`/alerts/${id}/acknowledge`);
}

export async function acknowledgeAllAlerts(): Promise<number> {
  const res = await api.post<{ acknowledged: number }>('/alerts/acknowledge-all', {});
  return res.acknowledged;
}
