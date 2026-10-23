import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { makeTerminalScrollbackSnapshotRef } from '../../terminal-scrollback-snapshots'
import { projectOrcadMigrationSessionScrollback } from '../migrating-orcad-catalog/orcad-source-scrollback-state'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  readWslMoveSleptScrollbackFromHistory,
  withSleptSnapshots
} from './wsl-move-slept-scrollback'

const TAB = 'feature-shell'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB}:${LEAF}`

function sleptSession(): WorkspaceSessionState {
  // What Sleep leaves: the layout names the pane, but no renderer buffer or snapshot ref.
  return {
    ...getDefaultWorkspaceSession(),
    terminalLayoutsByTabId: {
      [TAB]: { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    }
  }
}

describe('a slept pane on the snapshot channel', () => {
  it('carries the daemon checkpoint a slept pane has instead of a renderer snapshot', () => {
    const history = Buffer.from('$ make\r\nok\r\n$ ', 'utf8')
    const without = projectOrcadMigrationSessionScrollback(sleptSession())
    // Before the fix the moved terminal opened empty: nothing was carried.
    expect(without.snapshots).toEqual([])
    const projected = projectOrcadMigrationSessionScrollback(
      sleptSession(),
      undefined,
      false,
      (tabId, leafId) => (tabId === TAB && leafId === LEAF ? history : null)
    )
    const ref = makeTerminalScrollbackSnapshotRef(TAB, LEAF)
    expect(projected.blockedItems).toEqual([])
    expect(projected.snapshots).toEqual([
      {
        tabId: TAB,
        leafId: LEAF,
        ref,
        sha256: createHash('sha256').update(history).digest('hex'),
        byteLength: history.length
      }
    ])
    expect(projected.session.terminalLayoutsByTabId[TAB]?.scrollbackRefsByLeafId).toEqual({
      [LEAF]: ref
    })
  })

  it('serves those bytes to the host, and leaves any other ref to the store', () => {
    const history = Buffer.from('x'.repeat(10), 'utf8')
    const ref = makeTerminalScrollbackSnapshotRef(TAB, LEAF)
    const manifestWith = (sha256: string): OrcadMigrationManifest =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader reads only these fields.
      ({
        payload: {
          dormantState: {
            terminalScrollbackSnapshots: [
              { tabId: TAB, leafId: LEAF, ref, sha256, byteLength: history.length }
            ]
          }
        }
      }) as unknown as OrcadMigrationManifest
    const store = { readOrcadMigrationSourceSnapshotChunk: vi.fn(() => ({ bytesBase64: '', totalBytes: 0, eof: true })) }
    const source = withSleptSnapshots(store, new Map([[PANE_KEY, history]]))
    const signed = manifestWith(createHash('sha256').update(history).digest('hex'))
    expect(source.readOrcadMigrationSourceSnapshotChunk(signed, ref, 4)).toEqual({
      bytesBase64: Buffer.from('xxxxxx').toString('base64'),
      totalBytes: 10,
      eof: true
    })
    expect(store.readOrcadMigrationSourceSnapshotChunk).not.toHaveBeenCalled()
    // A renderer snapshot signed for the same ref is the store's to serve.
    source.readOrcadMigrationSourceSnapshotChunk(manifestWith('0'.repeat(64)), ref, 0)
    expect(store.readOrcadMigrationSourceSnapshotChunk).toHaveBeenCalledTimes(1)
  })

  it('reads the checkpoint a sleep left, scrollback first, keyed by the pane', async () => {
    const reader = {
      detectColdRestoreState: vi.fn(async (sessionId: string) =>
        sessionId === 'pty-1'
          ? {
              status: 'restored' as const,
              sessionId,
              hasUnreadableRecovery: false,
              restoreInfo: {
                scrollbackAnsi: 'old\r\n',
                snapshotAnsi: '$ ',
                rehydrateSequences: '',
                cwd: '/home/me',
                cols: 80,
                rows: 24,
                modes: {} as never
              }
            }
          : { status: 'none' as const }
      )
    }
    const buffers = await readWslMoveSleptScrollbackFromHistory(
      reader,
      [
        { paneKey: PANE_KEY, sessionId: 'pty-1', wslDistro: 'Ubuntu' },
        { paneKey: 'other:22222222-1111-4111-8111-111111111111', sessionId: 'pty-2' }
      ],
      'Ubuntu'
    )
    expect([...buffers]).toEqual([[PANE_KEY, Buffer.from('old\r\n$ ', 'utf8')]])
    expect(reader.detectColdRestoreState).toHaveBeenCalledWith('pty-1', {
      ignoreCleanEnd: true,
      wslDistro: 'Ubuntu'
    })
  })
})
