import { describe, expect, it } from 'vitest'
import { splitSshStatusMenuRows, type SshStatusMenuTarget } from './ssh-status-menu-rows'

function target(id: string, status: SshStatusMenuTarget['status']): SshStatusMenuTarget {
  return { id, label: id, status }
}

describe('splitSshStatusMenuRows', () => {
  it('keeps every connected and in-progress host and caps only idle ones', () => {
    const rows = splitSshStatusMenuRows(
      [
        target('a', 'disconnected'),
        target('b', 'disconnected'),
        target('c', 'disconnected'),
        target('d', 'auth-failed'),
        target('e', 'connected')
      ],
      { idleRowLimit: 1 }
    )
    expect(rows.connected.map((row) => row.id)).toEqual(['e'])
    expect(rows.inactive.map((row) => row.id)).toEqual(['d', 'a'])
    expect(rows.hiddenIdleCount).toBe(2)
  })

  it('fills the idle cap with hosts that own projects before the rest of the config', () => {
    const rows = splitSshStatusMenuRows(
      [target('a', 'disconnected'), target('b', 'disconnected'), target('c', 'disconnected')],
      { projectHostIds: new Set(['c']), idleRowLimit: 2 }
    )
    expect(rows.inactive.map((row) => row.id)).toEqual(['c', 'a'])
    expect(rows.hiddenIdleCount).toBe(1)
  })

  it('narrows every not-connected host by a case-insensitive label match', () => {
    const rows = splitSshStatusMenuRows(
      [
        target('web-1', 'disconnected'),
        target('db-1', 'disconnected'),
        target('db-2', 'error'),
        target('web-2', 'auth-failed'),
        target('db-3', 'connected')
      ],
      { query: ' WEB ' }
    )
    expect(rows.connected.map((row) => row.id)).toEqual(['db-3'])
    expect(rows.inactive.map((row) => row.id)).toEqual(['web-2', 'web-1'])
    expect(rows.queryMatched).toBe(true)
    expect(splitSshStatusMenuRows([target('a', 'disconnected')], { query: 'z' }).queryMatched).toBe(
      false
    )
  })

  it('hides nothing at or under the limit', () => {
    const rows = splitSshStatusMenuRows([target('a', 'disconnected')], { idleRowLimit: 1 })
    expect(rows.hiddenIdleCount).toBe(0)
    expect(rows.inactive).toHaveLength(1)
  })
})
