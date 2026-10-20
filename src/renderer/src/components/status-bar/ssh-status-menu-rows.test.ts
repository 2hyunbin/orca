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
      1
    )
    expect(rows.connected.map((row) => row.id)).toEqual(['e'])
    expect(rows.inactive.map((row) => row.id)).toEqual(['d', 'a'])
    expect(rows.hiddenIdleCount).toBe(2)
  })

  it('hides nothing at or under the limit', () => {
    const rows = splitSshStatusMenuRows([target('a', 'disconnected')], 1)
    expect(rows.hiddenIdleCount).toBe(0)
    expect(rows.inactive).toHaveLength(1)
  })
})
