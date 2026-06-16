/* eslint-disable @typescript-eslint/no-explicit-any */
import type { JobType, JobHandler } from '../../types/job-queue.js';

export const HANDLERS: Map<JobType, JobHandler<any, any>> = new Map();

export function registerHandler(handler: JobHandler<any, any>): void {
  if (HANDLERS.has(handler.jobType)) {
    throw new Error(`Handler for ${handler.jobType} already registered`);
  }
  HANDLERS.set(handler.jobType, handler);
}

export function getHandler(jobType: JobType): JobHandler<any, any> | undefined {
  return HANDLERS.get(jobType);
}

export function getAllHandlers(): JobHandler<any, any>[] {
  return Array.from(HANDLERS.values());
}
