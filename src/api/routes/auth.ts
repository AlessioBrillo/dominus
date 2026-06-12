import { Router } from 'express';
import type { AuthProvider } from '../../providers/auth/auth-provider.js';

export interface LoginRequest {
  apiKey: string;
}

export interface LoginResponse {
  authenticated: boolean;
  token?: string;
  identity?: string;
  error?: string;
}

export function createAuthRouter(authProvider: AuthProvider): Router {
  const router = Router();

  router.post('/login', async (req, res) => {
    const { apiKey } = req.body as LoginRequest;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      res.status(400).json({
        authenticated: false,
        error: 'API key is required',
      } satisfies LoginResponse);
      return;
    }

    const result = await authProvider.validate(apiKey.trim());

    if (!result.authenticated) {
      res.status(403).json({
        authenticated: false,
        error: 'Invalid API key',
      } satisfies LoginResponse);
      return;
    }

    res.json({
      authenticated: true,
      token: apiKey.trim(),
      identity: result.keyName ?? 'default',
    } satisfies LoginResponse);
  });

  return router;
}
