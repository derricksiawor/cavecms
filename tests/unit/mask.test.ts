import { describe, it, expect } from 'vitest'
import { maskLead } from '@/lib/leads/mask'

describe('maskLead', () => {
  it('returns identical object for admin and editor', () => {
    const l = {
      name: 'John Doe',
      email: 'j@example.com',
      phone: '+233241234567',
      message: 'hi j@x.com call +233 24 555 1111',
    }
    expect(maskLead(l, 'admin')).toEqual(l)
    expect(maskLead(l, 'editor')).toEqual(l)
  })

  it('masks all PII fields for viewer', () => {
    const m = maskLead(
      {
        name: 'John Doe Smith',
        email: 'john.doe@example.com',
        phone: '+233241234567',
        message: 'Call me at +233 24 555 1111 or j@x.com.',
      },
      'viewer',
    )
    expect(m.name).toBe('JDS')
    expect(m.email).toMatch(/^j\*\*\*@example\.com$/)
    expect(m.phone).toBe('***4567')
    expect(m.message).toContain('[email]')
    expect(m.message).toContain('[phone]')
  })

  it('caps name initials to 3 characters', () => {
    const m = maskLead(
      { name: 'A B C D E F', email: null, phone: null, message: null },
      'viewer',
    )
    expect(m.name).toBe('ABC')
  })

  it('handles single-word names', () => {
    const m = maskLead(
      { name: 'Cher', email: null, phone: null, message: null },
      'viewer',
    )
    expect(m.name).toBe('C')
  })

  it('passes through null fields untouched', () => {
    const m = maskLead(
      { name: null, email: null, phone: null, message: null },
      'viewer',
    )
    expect(m.name).toBe('')
    expect(m.email).toBeNull()
    expect(m.phone).toBeNull()
    expect(m.message).toBe('')
  })

  it('truncates long messages to 80 characters', () => {
    const long = 'x'.repeat(200)
    const m = maskLead(
      { name: null, email: null, phone: null, message: long },
      'viewer',
    )
    expect(m.message!.length).toBeLessThanOrEqual(80)
  })

  it('preserves additional fields outside the maskable set', () => {
    const m = maskLead(
      {
        name: 'Alpha Bravo',
        email: 'a@b.co',
        phone: null,
        message: null,
        source: 'contact',
        status: 'new',
        id: 7,
      },
      'viewer',
    )
    expect(m.source).toBe('contact')
    expect(m.status).toBe('new')
    expect(m.id).toBe(7)
    expect(m.name).toBe('AB')
  })

  it('does not leak local-part beyond first character for viewer', () => {
    const m = maskLead(
      {
        name: null,
        email: 'verylongemailaddress@domain.test',
        phone: null,
        message: null,
      },
      'viewer',
    )
    expect(m.email).toBe('v***@domain.test')
  })

  it('masks emails containing dots in the local part', () => {
    const m = maskLead(
      { name: null, email: 'first.last@x.io', phone: null, message: null },
      'viewer',
    )
    expect(m.email).toBe('f***@x.io')
  })

  it('redacts malformed emails (missing @) for viewer', () => {
    const m = maskLead(
      { name: null, email: 'not-a-real-email', phone: null, message: null },
      'viewer',
    )
    expect(m.email).toBe('***')
  })

  it('redacts degenerate emails like "@x" and "foo@" for viewer', () => {
    expect(
      maskLead(
        { name: null, email: '@x.io', phone: null, message: null },
        'viewer',
      ).email,
    ).toBe('***')
    expect(
      maskLead(
        { name: null, email: 'foo@', phone: null, message: null },
        'viewer',
      ).email,
    ).toBe('***')
    expect(
      maskLead(
        { name: null, email: '@', phone: null, message: null },
        'viewer',
      ).email,
    ).toBe('***')
  })

  it('keeps last four phone digits for viewer', () => {
    const m = maskLead(
      { name: null, email: null, phone: '02012345678', message: null },
      'viewer',
    )
    expect(m.phone).toBe('***5678')
  })

  it('strips emails AND phones from the message for viewer', () => {
    const m = maskLead(
      {
        name: null,
        email: null,
        phone: null,
        message: 'reach me a@b.io +233 24 111 2222 ok',
      },
      'viewer',
    )
    expect(m.message).not.toMatch(/a@b\.io/)
    expect(m.message).not.toMatch(/\+233/)
    expect(m.message).toContain('[email]')
    expect(m.message).toContain('[phone]')
  })
})
