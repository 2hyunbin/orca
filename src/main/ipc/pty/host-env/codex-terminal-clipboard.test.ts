import { describe, expect, it } from 'vitest'
import { applyCodexRemoteViewerClipboardEnv } from './codex-terminal-clipboard'

describe('applyCodexRemoteViewerClipboardEnv', () => {
  it('never overrides an SSH session the launch already carries', () => {
    const env: Record<string, string> = { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' }
    applyCodexRemoteViewerClipboardEnv(env, {
      launchAgent: 'codex',
      viewerIsRemote: true,
      inheritedEnv: {}
    })
    expect(env.SSH_CONNECTION).toBe('10.0.0.1 5000 10.0.0.2 22')
  })

  it.each([
    ['SSH_CONNECTION', '10.0.0.1 5000 10.0.0.2 22'],
    ['SSH_TTY', '/dev/ttys004']
  ])('skips when the host process already inherits %s', (key, value) => {
    const env: Record<string, string> = {}
    applyCodexRemoteViewerClipboardEnv(env, {
      launchAgent: 'codex',
      viewerIsRemote: true,
      inheritedEnv: { [key]: value }
    })
    expect(env.SSH_CONNECTION).toBeUndefined()
  })
})
