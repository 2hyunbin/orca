import { describe, expect, it } from 'vitest'
import type { ColdRestoreDetection } from '../../daemon/history-reader'
import { captureWslMoveRestoreHints } from './wsl-move-restore-hints'

const restored = (cwd: string): ColdRestoreDetection => ({
  status: 'restored',
  sessionId: 's',
  hasUnreadableRecovery: false,
  restoreInfo: {
    snapshotAnsi: '',
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd,
    cols: 80,
    rows: 24,
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    }
  }
})

describe('captureWslMoveRestoreHints', () => {
  it('keeps each pane its last folder in the Linux form the host opens', async () => {
    const answers: Record<string, ColdRestoreDetection> = {
      'wt@@a': restored('\\\\wsl.localhost\\Ubuntu\\home\\dev\\app\\src'),
      'wt@@b': restored('/home/dev/app/test'),
      'wt@@c': restored('\\\\wsl.localhost\\Debian\\home\\dev'),
      'wt@@d': restored('C:\\Users\\dev'),
      'wt@@e': { status: 'none' },
      'wt@@f': { status: 'unreadable', sessionId: 'wt@@f' }
    }
    const seen: unknown[] = []
    const capture = await captureWslMoveRestoreHints(
      {
        detectColdRestoreState: async (sessionId, opts) => {
          seen.push(opts)
          return answers[sessionId] ?? { status: 'none' }
        }
      },
      ['a', 'b', 'c', 'd', 'e', 'f'].map((leaf) => ({
        paneKey: `t:${leaf}`,
        sessionId: `wt@@${leaf}`
      })),
      'Ubuntu'
    )
    expect(capture).toEqual({
      hints: [
        { paneKey: 't:a', cwd: '/home/dev/app/src' },
        { paneKey: 't:b', cwd: '/home/dev/app/test' }
      ],
      unreadablePaneKeys: ['t:f']
    })
    // A sleep ends sessions cleanly; the read must not skip them for it.
    expect(seen[0]).toEqual({ ignoreCleanEnd: true, wslDistro: 'Ubuntu' })
  })
})
