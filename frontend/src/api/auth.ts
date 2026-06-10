import { storeApiKey } from './client.js';
import { api } from './client.js';

export interface AuthResult {
  success: boolean;
  error?: string;
}

export async function verifyAndStoreKey(apiKey: string): Promise<AuthResult> {
  try {
    storeApiKey(apiKey);
    await api.get('/api/health');
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Authentication failed';
    return { success: false, error: message };
  }
}
