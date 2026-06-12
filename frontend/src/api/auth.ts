import { api, storeApiKey } from './client.js';

export interface AuthResult {
  success: boolean;
  error?: string;
}

export interface LoginResponse {
  authenticated: boolean;
  token?: string;
  identity?: string;
  error?: string;
}

export async function verifyAndStoreKey(apiKey: string): Promise<AuthResult> {
  try {
    const result = await api.post<LoginResponse>('/auth/login', { apiKey });
    if (result.authenticated && result.token) {
      storeApiKey(result.token);
      return { success: true };
    }
    return { success: false, error: result.error ?? 'Authentication failed' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Authentication failed';
    return { success: false, error: message };
  }
}

export async function checkHealth(): Promise<boolean> {
  try {
    await api.get<{ status: string }>('/health');
    return true;
  } catch {
    return false;
  }
}
