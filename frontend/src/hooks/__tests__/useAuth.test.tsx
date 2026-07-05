import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../useAuth.js';
import * as client from '../../api/client.js';
import * as auth from '../../api/auth.js';
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

  it('login validates key and sets authenticated on success', async () => {
    const verifySpy = vi.spyOn(auth, 'verifyAndStoreKey').mockResolvedValue({ success: true });
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await result.current.login('new-key-456');
    });

    expect(verifySpy).toHaveBeenCalledWith('new-key-456');
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('login throws on invalid key and does not set authenticated', async () => {
    vi.spyOn(auth, 'verifyAndStoreKey').mockResolvedValue({
      success: false,
      error: 'Invalid API key',
    });
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await expect(result.current.login('bad-key')).rejects.toThrow('Invalid API key');
    });

    expect(result.current.isAuthenticated).toBe(false);
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
