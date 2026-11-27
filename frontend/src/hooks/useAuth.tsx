// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { getStoredApiKey, clearApiKey, clearDeviceToken, setOnUnauthorized } from '@/api/client';
import {
  verifyAndStoreKey,
  getSsoStatus,
  ssoLogout,
  getMagicLinkSession,
  magicLinkLogout,
} from '@/api/auth';

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (key: string) => Promise<void>;
  /** Accept a cookie session established by a magic link (no API key). */
  loginWithSession: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setOnUnauthorized(() => {
      setIsAuthenticated(false);
    });

    const stored = getStoredApiKey();
    if (stored !== null) {
      setIsAuthenticated(true);
      setIsLoading(false);
      return;
    }

    // SSO session restore (ADR-0062): the browser may hold a valid
    // dominus_session cookie without a stored API key (enterprise login).
    let cancelled = false;
    // Two browser session flows mint the same cookie: enterprise SSO and
    // the passwordless magic link. Neither leaves an API key in the SPA.
    Promise.all([getSsoStatus(), getMagicLinkSession()])
      .then(([{ session }, magicSession]) => {
        if (!cancelled && (session?.authenticated || magicSession?.authenticated)) {
          setIsAuthenticated(true);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (key: string) => {
    const result = await verifyAndStoreKey(key);
    if (!result.success) {
      throw new Error(result.error ?? 'Authentication failed');
    }
    setIsAuthenticated(true);
  }, []);

  const loginWithSession = useCallback(() => {
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    clearApiKey();
    clearDeviceToken();
    void ssoLogout();
    void magicLinkLogout();
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, login, loginWithSession, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
