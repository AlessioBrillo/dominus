import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../useAuth.js';
import * as client from '../../api/client.js';
import type { ReactNode } from 'react';

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('useAuth', () => {
  it('returns unauthenticated when no key is stored', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it('returns authenticated when key is stored in sessionStorage', () => {
    vi.spyOn(client, 'getStoredApiKey').mockReturnValue('test-key-123');
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('login stores key and sets authenticated', () => {
    const storeSpy = vi.spyOn(client, 'storeApiKey');
    const { result } = renderHook(() => useAuth(), { wrapper });

    act(() => {
      result.current.login('new-key-456');
    });

    expect(storeSpy).toHaveBeenCalledWith('new-key-456');
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('logout clears key and sets unauthenticated', () => {
    vi.spyOn(client, 'getStoredApiKey').mockReturnValue('test-key-123');
    const clearSpy = vi.spyOn(client, 'clearApiKey');
    const { result } = renderHook(() => useAuth(), { wrapper });

    act(() => {
      result.current.logout();
    });

    expect(clearSpy).toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('throws error when used outside AuthProvider', () => {
    expect(() => {
      renderHook(() => useAuth());
    }).toThrow('useAuth must be used within AuthProvider');
  });
});
