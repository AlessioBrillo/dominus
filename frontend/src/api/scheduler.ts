import { api } from './client.js';

export interface SchedulerJob {
  name: string;
  cron: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: string;
}

export interface SchedulerStatusResponse {
  jobs: SchedulerJob[];
}

export async function fetchSchedulerStatus(): Promise<SchedulerJob[]> {
  const data = await api.get<SchedulerStatusResponse>('/scheduler');
  return data.jobs;
}

export async function runSchedulerJob(jobName: string): Promise<{ started: boolean }> {
  return api.post<{ started: boolean }>(`/scheduler/run/${encodeURIComponent(jobName)}`);
}
