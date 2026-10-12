import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { HeadlessSeedMetadata } from './runtime-terminal-state-records'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../shared/runtime-types'

class QueryRuntime extends OrcaRuntimeService {
  readonly calls: string[] = []
  surfaceReads = 0

  override getRendererTerminalSerializerGeneration(ptyId: string): number {
    this.calls.push(`generation:${ptyId}`)
    return 27
  }

  override getTerminalSize(ptyId: string): { cols: number; rows: number } {
    this.calls.push(`grid:${ptyId}`)
    return { cols: 100, rows: 40 }
  }

  protected override disposeHeadlessTerminal(ptyId: string): void {
    this.calls.push(`dispose:${ptyId}`)
  }

  override seedHeadlessTerminal(
    ptyId: string,
    data: string,
    size?: { cols: number; rows: number },
    metadata: HeadlessSeedMetadata = {}
  ): void {
    this.calls.push(`seed:${ptyId}:${data}:${size?.cols}:${metadata.cwd}`)
  }

  protected override resizeHeadlessTerminal(ptyId: string, cols: number, rows: number): void {
    this.calls.push(`resize:${ptyId}:${cols}:${rows}`)
  }

  protected override trackHeadlessTerminalData(ptyId: string, data: string, seq?: number): void {
    this.calls.push(`data:${ptyId}:${data}:${seq}`)
  }

  protected override findMobileTerminalSurface(
    _worktreeId: string,
    _parentTabId: string,
    _options: { requireReady?: boolean } = {}
  ): RuntimeMobileSessionCreateTerminalResult | null {
    this.surfaceReads += 1
    return null
  }

  ptyHandle(ptyId: string): string {
    this.registerPty(ptyId, 'repo::/tmp/query-workspace')
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      throw new Error('missing_test_pty')
    }
    return this.issuePtyHandle(pty)
  }

  recoveryState(ptyId: string): { preferred: boolean; hydration: string | undefined } {
    return {
      preferred: this.providerSnapshotPreferredPtys.has(ptyId),
      hydration: this.headlessHydrationState.get(ptyId)
    }
  }

  waitForSurface(signal: AbortSignal): Promise<RuntimeMobileSessionCreateTerminalResult> {
    return this.waitForMobileTerminalSurface('repo::/tmp/query-workspace', 'tab-query', { signal })
  }

  get pendingGraphChecks(): number {
    return this.graphSyncCallbacks.length
  }
}

describe('terminal query runtime re-entry', () => {
  it('uses the public renderer generation override for a handle', () => {
    const runtime = new QueryRuntime(null)
    const handle = runtime.ptyHandle('pty-query')
    expect(runtime.getRendererTerminalSerializerGenerationForHandle(handle)).toBe(27)
    expect(runtime.calls).toEqual(['generation:pty-query'])
    runtime.onPtyExit('pty-query', 0)
  })

  it('recovers through the current runtime overrides in the original output order', () => {
    const runtime = new QueryRuntime(null)
    runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
      'pty-recovery',
      { data: 'snapshot', cols: 80, rows: 24, cwd: '/tmp/query' },
      [{ data: 'tail', seq: 7 }]
    )
    expect(runtime.calls).toEqual([
      'dispose:pty-recovery',
      'seed:pty-recovery:snapshot:80:/tmp/query',
      'grid:pty-recovery',
      'resize:pty-recovery:100:40',
      'data:pty-recovery:tail:7'
    ])
    expect(runtime.recoveryState('pty-recovery')).toEqual({ preferred: true, hydration: 'done' })
    runtime.onPtyExit('pty-recovery', 0)
  })

  it('leaves output ownership untouched when the recovery snapshot is empty', () => {
    const runtime = new QueryRuntime(null)
    runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery('pty-empty', {
      data: '',
      cols: 80,
      rows: 24
    })
    expect(runtime.calls).toEqual([])
    expect(runtime.recoveryState('pty-empty')).toEqual({ preferred: false, hydration: undefined })
  })

  it('uses the protected surface override and removes its graph subscription on abort', async () => {
    const runtime = new QueryRuntime(null)
    const client = new AbortController()
    const waiting = runtime.waitForSurface(client.signal)
    expect(runtime.surfaceReads).toBe(2)
    expect(runtime.pendingGraphChecks).toBe(1)
    client.abort()
    await expect(waiting).rejects.toThrow('client_disconnected')
    expect(runtime.pendingGraphChecks).toBe(0)
  })
})
