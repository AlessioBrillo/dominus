// SPDX-License-Identifier: AGPL-3.0-only
import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    tenantId?: string;
    auth?: {
      userId?: string | undefined;
      tenantId?: string | undefined;
      role?: string | undefined;
      keyName?: string | undefined;
    };
  }
}
