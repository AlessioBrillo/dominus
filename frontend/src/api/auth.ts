// SPDX-License-Identifier: AGPL-3.0-only
import { api, storeApiKey, ApiError } from './client.js';

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

export interface RegisterResponse {
  tenantId: string;
  /** The one-time API key. Absent when the address must be verified first. */
  key?: string;
  prefix?: string;
  /** True when the workspace is inert until the emailed link is opened. */
  verificationRequired?: boolean;
  message: string;
}

export interface VerificationResponse {
  tenantId: string;
  key: string;
  prefix: string;
  message: string;
}

export interface SsoSession {
  authenticated: boolean;
  sub?: string | null;
  tenantId?: string | null;
  role?: string | null;
}

export async function registerTenant(input: {
  name: string;
  email: string;
}): Promise<RegisterResponse> {
  return api.post<RegisterResponse>('/auth/register', input);
}

/** Redeem the signup token: the workspace becomes usable and the key is shown. */
export async function verifyEmail(token: string): Promise<VerificationResponse> {
  return api.post<VerificationResponse>('/auth/verify-email', { token });
}

/** Ask for a new signup link. The answer is the same for every address. */
export async function resendVerification(email: string): Promise<{ sent: boolean }> {
  return api.post<{ sent: boolean }>('/auth/resend-verification', { email });
}

/** Ask for a recovery link. The answer is the same for every address. */
export async function requestRecovery(email: string): Promise<{ sent: boolean }> {
  return api.post<{ sent: boolean }>('/auth/recover', { email });
}

/** Redeem a recovery token and receive a new API key. */
export async function confirmRecovery(token: string): Promise<VerificationResponse> {
  return api.post<VerificationResponse>('/auth/recover/confirm', { token });
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

/** Whether the backend mounts the SSO flow (ADR-0062) and whether the
 *  browser already holds a valid session cookie. 404 = SSO not configured;
 *  401 = configured but signed out. */
export async function getSsoStatus(): Promise<{ available: boolean; session: SsoSession | null }> {
  try {
    const session = await api.get<SsoSession>('/auth/oidc/me');
    return { available: true, session };
  } catch (err: unknown) {
    if (err instanceof ApiError && err.status === 404) return { available: false, session: null };
    return { available: true, session: null };
  }
}

export function startSsoLogin(): void {
  window.location.assign('/api/v1/auth/oidc/start');
}

export async function ssoLogout(): Promise<void> {
  try {
    const { logoutUrl } = await api.post<{ logoutUrl?: string }>('/auth/oidc/logout');
    // End the identity-provider session too, otherwise the next SSO sign-in
    // would silently log the same user back in.
    if (logoutUrl) window.location.assign(logoutUrl);
  } catch {
    /* non-fatal — the local key is cleared regardless */
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
