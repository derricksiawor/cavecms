import { describe, it, expect } from 'vitest'
import {
  parseScopes,
  tokenAllowsScope,
  SCOPE_RESOURCES,
  SCOPE_ACTIONS,
} from '@/lib/auth/apiTokenScope'

describe('API token scopes', () => {
  it('exposes the resource + action vocabulary', () => {
    expect(SCOPE_RESOURCES).toContain('pages')
    expect(SCOPE_RESOURCES).toContain('settings')
    expect(SCOPE_ACTIONS).toEqual(['read', 'write', 'delete'])
  })

  it('null scopes = unrestricted (legacy/back-compat token)', () => {
    expect(tokenAllowsScope(null, 'pages', 'delete')).toBe(true)
    expect(tokenAllowsScope(null, 'settings', 'write')).toBe(true)
  })

  it('write implies read for the same resource; delete implies write+read', () => {
    expect(tokenAllowsScope(['pages:write'], 'pages', 'read')).toBe(true)
    expect(tokenAllowsScope(['pages:write'], 'pages', 'write')).toBe(true)
    expect(tokenAllowsScope(['pages:write'], 'pages', 'delete')).toBe(false)
    expect(tokenAllowsScope(['pages:delete'], 'pages', 'write')).toBe(true)
  })

  it('scopes are per-resource — a pages grant does not leak to posts', () => {
    expect(tokenAllowsScope(['pages:write'], 'posts', 'read')).toBe(false)
  })

  it('empty array = no grants = deny everything', () => {
    expect(tokenAllowsScope([], 'pages', 'read')).toBe(false)
  })

  it('parseScopes normalises JSON/array/null and drops garbage', () => {
    expect(parseScopes(null)).toBe(null)
    expect(parseScopes('["pages:write","posts:read"]')).toEqual([
      'pages:write',
      'posts:read',
    ])
    expect(parseScopes(['pages:write', 'bogus', 'pages:fly'])).toEqual([
      'pages:write',
    ])
    expect(parseScopes('not json')).toBe(null)
  })
})
