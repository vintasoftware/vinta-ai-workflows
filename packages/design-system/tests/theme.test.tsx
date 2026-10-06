import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { applyTheme, readThemePreference, useTheme } from '../src/lib/theme.ts'

const KEY = 'test-theme'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})
afterEach(cleanup)

test('applying a theme toggles the class the tokens key off', () => {
  expect(applyTheme('dark')).toBe('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(applyTheme('light')).toBe('light')
  expect(document.documentElement.classList.contains('dark')).toBe(false)
})

test('system is the default, and nonsense in storage reads as system', () => {
  expect(readThemePreference(KEY)).toBe('system')
  localStorage.setItem(KEY, 'sepia')
  expect(readThemePreference(KEY)).toBe('system')
  localStorage.setItem(KEY, 'dark')
  expect(readThemePreference(KEY)).toBe('dark')
})

test('the hook remembers the preference and writes the root class', () => {
  const { result } = renderHook(() => useTheme(KEY))
  expect(result.current.preference).toBe('system')
  // jsdom has no matchMedia, so `system` resolves to light — the safe default.
  expect(result.current.resolved).toBe('light')

  act(() => result.current.setPreference('dark'))
  expect(result.current.resolved).toBe('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(localStorage.getItem(KEY)).toBe('dark')

  // A second mount starts from what the first one stored.
  const again = renderHook(() => useTheme(KEY))
  expect(again.result.current.preference).toBe('dark')
})
