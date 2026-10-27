import { describe, expect, it, vi } from 'vitest'
import type { Cookie } from 'electron'
import { clearGoogleCookies } from './browser-google-cookie-clear'
import { acquireCookieMutationLock } from './browser-cookie-import-clear'

vi.mock('electron', () => ({ session: {} }))

function cookie(domain: string, name = domain, path = '/'): Cookie {
  return {
    domain,
    name,
    path,
    value: 'value',
    secure: true,
    httpOnly: false,
    session: true,
    hostOnly: !domain.startsWith('.'),
    sameSite: 'no_restriction'
  }
}

function jar(initial: Cookie[]) {
  let rows = initial
  const get = vi.fn(async () => rows)
  const remove = vi.fn(async (url: string, name: string) => {
    const host = new URL(url).hostname
    const path = new URL(url).pathname
    rows = rows.filter(
      (row) => !(row.domain?.replace(/^\./, '') === host && row.name === name && row.path === path)
    )
  })
  return { cookies: { get, remove } }
}

describe('Google-only cookie clearing', () => {
  it('uses the import exclusion, deduplicates partition twins and keeps other sites', async () => {
    const other = [cookie('youtube.com'), cookie('google.com.evil.example'), cookie('example.com')]
    const target = jar([
      cookie('.google.com'),
      cookie('accounts.google.com', 'twins'),
      cookie('accounts.google.com', 'twins'),
      cookie('google.com', 'path', '/one'),
      cookie('google.com', 'path', '/two'),
      ...other
    ])
    expect(await clearGoogleCookies(target)).toBe('cleared')
    expect(await target.cookies.get()).toEqual(other)
    expect(target.cookies.remove).toHaveBeenCalledTimes(4)
    expect(await clearGoogleCookies(target)).toBe('empty')
  })

  it('reports the re-read truth after a rejection, and continues other selectors', async () => {
    const target = jar([cookie('google.com'), cookie('accounts.google.com')])
    const remove = target.cookies.remove.getMockImplementation()!
    target.cookies.remove.mockImplementationOnce(async (url, name) => {
      await remove(url, name)
      throw new Error('rejected after deletion')
    })
    expect(await clearGoogleCookies(target)).toBe('cleared')
    expect(target.cookies.remove).toHaveBeenCalledTimes(2)
  })

  it('reports survivors even when remove resolves, and still clears other selectors', async () => {
    const target = jar([cookie('google.com'), cookie('accounts.google.com')])
    target.cookies.remove.mockImplementationOnce(async () => {})
    expect(await clearGoogleCookies(target)).toBe('remaining')
    expect(await target.cookies.get()).toEqual([cookie('google.com')])
  })

  it.each([1, 2])('never reports empty when enumeration %s fails', async (read) => {
    const target = jar([cookie('google.com')])
    if (read === 2) {
      target.cookies.get.mockResolvedValueOnce([cookie('google.com')])
    }
    target.cookies.get.mockRejectedValueOnce(new Error('read failed'))
    expect(await clearGoogleCookies(target)).toBe('unverified')
  })

  it('validates again after waiting for the import Session lock, before removing anything', async () => {
    const target = jar([cookie('google.com')])
    const release = await acquireCookieMutationLock(target)
    const validate = vi.fn(() => {
      throw new Error('pairing changed')
    })
    const clear = clearGoogleCookies(target, validate)
    expect(validate).not.toHaveBeenCalled()
    release()
    await expect(clear).rejects.toThrow('pairing changed')
    expect(target.cookies.remove).not.toHaveBeenCalled()
  })
})
