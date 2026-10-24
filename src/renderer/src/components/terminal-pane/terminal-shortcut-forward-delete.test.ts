import { describe, expect, it } from 'vitest'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'

const altDelete = {
  key: 'Delete',
  code: 'Delete',
  metaKey: false,
  ctrlKey: false,
  altKey: true,
  shiftKey: false
}

describe('Option/Alt + Forward-Delete', () => {
  it('sends ESC d on macOS because Claude Code reads CSI 3;3~ as kill-to-end-of-line', () => {
    expect(resolveTerminalShortcutAction(altDelete, true)).toEqual({
      type: 'sendInput',
      data: '\x1bd'
    })
  })

  it('leaves Linux and Windows on xterm native CSI 3;3~', () => {
    expect(resolveTerminalShortcutAction(altDelete, false)).toBeNull()
    expect(resolveTerminalShortcutAction(altDelete, false, 'false', 0, true)).toBeNull()
  })

  it('defers to xterm kitty encoding when the app negotiated it', () => {
    expect(
      resolveTerminalShortcutAction(
        altDelete,
        true,
        'false',
        0,
        false,
        undefined,
        undefined,
        () => 1
      )
    ).toBeNull()
  })
})
