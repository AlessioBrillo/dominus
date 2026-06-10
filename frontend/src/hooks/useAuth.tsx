import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { getStoredApiKey, clearApiKey, storeApiKey } from '../api/client.js';

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (key: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const stored = getStoredApiKey();
    setIsAuthenticated(stored !== null);
    setIsLoading(false);
  }, []);

  const login = useCallback((key: string) => {
    storeApiKey(key);
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    clearApiKey();
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
