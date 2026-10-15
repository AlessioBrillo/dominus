// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';

export interface AutomationSwitch {
  enabled: boolean;
  dryRun: boolean;
}

export interface AutomationEffective extends AutomationSwitch {
  refusedBy?: 'global_kill_switch' | 'tenant_switch';
}

export interface AutomationSettings {
  global: AutomationSwitch;
  tenant: AutomationSwitch;
  effective: AutomationEffective;
}

export interface AutomationSettingsResponse {
  settings: AutomationSettings;
}

export interface AutomationSettingsUpdate {
  enabled?: boolean;
  dryRun?: boolean;
}

export type AutomationStepName = 'portfolio' | 'site' | 'indexing' | 'dns' | 'parking' | 'listing';

export type AutomationStepStatus = 'pending' | 'done' | 'skipped' | 'failed';

export interface AutomationStep {
  id: number;
  domain: string;
  step: AutomationStepName;
  status: AutomationStepStatus;
  attempts: number;
  source: string;
  pipelineRunId: string | null;
  detailJson: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationAuditEntry {
  id: number;
  action: string;
  domain: string | null;
  actor: string;
  detailJson: string | null;
  createdAt: string;
}

export function getAutomationSettings(): Promise<AutomationSettingsResponse> {
  return api.get<AutomationSettingsResponse>('/automation/settings');
}

export function updateAutomationSettings(
  update: AutomationSettingsUpdate,
): Promise<AutomationSettingsResponse> {
  return api.put<AutomationSettingsResponse>('/automation/settings', update);
}

export function getAutomationSteps(params: {
  domain?: string;
  status?: AutomationStepStatus;
  limit?: number;
}): Promise<{ steps: AutomationStep[] }> {
  const query = new URLSearchParams();
  if (params.domain) query.set('domain', params.domain);
  if (params.status) query.set('status', params.status);
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString() ? `?${query.toString()}` : '';
  return api.get<{ steps: AutomationStep[] }>(`/automation/steps${qs}`);
}

export function getAutomationAudit(limit = 50): Promise<{ entries: AutomationAuditEntry[] }> {
  return api.get<{ entries: AutomationAuditEntry[] }>(`/automation/audit?limit=${limit}`);
}

export function runAutomation(domain: string): Promise<{ result: unknown }> {
  return api.post<{ result: unknown }>('/automation/run', { domain, source: 'manual' });
}

export function resetAutomation(domain: string): Promise<{ domain: string }> {
  return api.post<{ domain: string }>('/automation/reset', { domain });
}
