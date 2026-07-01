import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    signal?: AbortSignal | undefined;
    tenantId?: string;
  }
}
