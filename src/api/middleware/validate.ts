import type { Request, Response, NextFunction } from 'express';
import { z, type ZodSchema } from 'zod';

export interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export function validate(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) {
        const result = schemas.params.safeParse(req.params);
        if (!result.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Path parameters failed validation',
              issues: result.error.issues,
            },
          });
          return;
        }
      }

      if (schemas.query) {
        const result = schemas.query.safeParse(req.query);
        if (!result.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Query parameters failed validation',
              issues: result.error.issues,
            },
          });
          return;
        }
      }

      if (schemas.body) {
        const result = schemas.body.safeParse(req.body);
        if (!result.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request body failed validation',
              issues: result.error.issues,
            },
          });
          return;
        }
        req.body = result.data;
      }

      next();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Validation middleware error';
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message },
      });
    }
  };
}

export const domainParamSchema = z.object({
  domain: z.string().min(1).max(255),
});

export const runIdParamSchema = z.object({
  runId: z.string().min(1).max(255),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});
