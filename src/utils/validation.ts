import { type z } from 'zod';

export function parseZodError(err: z.ZodError): { code: string; message: string; issues: unknown } {
  return {
    code: 'VALIDATION_ERROR',
    message: 'Request body failed validation',
    issues: err.issues,
  };
}

export function paramError(param: string): { error: { code: string; message: string } } {
  return { error: { code: 'BAD_REQUEST', message: `${param} is required` } };
}
