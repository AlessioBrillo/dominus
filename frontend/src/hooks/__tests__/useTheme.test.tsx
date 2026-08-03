// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, render, screen } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../useTheme';

const STORAGE_KEY = 'dominus_theme';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.classList.remove('dark', 'light');
});

describe('ThemeProvider', () => {
  it('defaults to dark when nothing is stored and no light preference', () => {
    render(<ThemeProvider>content</ThemeProvider>);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe('dark');
  });

  it('reads a stored theme', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe('light');
  });

  it('reads a stored theme with a dark value', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe('dark');
  });

  it('falls back to light when the OS prefers light', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as MediaQueryList);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe('light');
  });

  it('ignores corrupt stored values', () => {
    localStorage.setItem(STORAGE_KEY, 'neon');
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
    } as MediaQueryList);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe('dark');
  });

  it('toggles between dark and light and persists', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('tolerates localStorage being unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe('dark');
    expect(() => act(() => result.current.toggleTheme())).not.toThrow();
  });
});

describe('useTheme', () => {
  it('throws outside of a ThemeProvider', () => {
    expect(() => renderHook(() => useTheme())).toThrow(
      'useTheme must be used within a ThemeProvider',
    );
  });

  it('exposes a stable toggle callback', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    const first = result.current.toggleTheme;
    act(() => result.current.toggleTheme());
    expect(result.current.toggleTheme).toBe(first);
  });
});

beforeEach(() => {
  document.documentElement.classList.remove('dark', 'light');
});
