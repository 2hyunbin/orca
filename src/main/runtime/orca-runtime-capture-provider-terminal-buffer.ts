import { OrcaRuntimeWithSerializeTerminalBufferFromAvailableState } from './orca-runtime-serialize-terminal-buffer-from-available-state'
import type { PtyProviderBufferSnapshot } from '../providers/types'

import type { RuntimeTerminalRead } from '../../shared/runtime-types'
import type { RuntimeProviderSnapshotReadOptions } from './runtime-terminal-contracts'

import type { RuntimeTerminalProjection } from './orca-runtime-core'

export class OrcaRuntimeWithCaptureProviderTerminalBuffer extends OrcaRuntimeWithSerializeTerminalBufferFromAvailableState {
  protected captureProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number },
    generation: number
  ): Promise<PtyProviderBufferSnapshot | null> {
    return this.terminalOutput.captureProviderTerminalBuffer(ptyId, opts, generation)
  }

  protected withVisibleSnapshotFallback(
    ptyId: string,
    read: RuntimeTerminalRead,
    opts: { cursor?: number; limit?: number } = {},
    providerSnapshot: RuntimeProviderSnapshotReadOptions = {}
  ): Promise<RuntimeTerminalRead> {
    return this.terminalOutput.withVisibleSnapshotFallback(ptyId, read, opts, providerSnapshot)
  }

  protected readProviderTerminalTailLines(
    ptyId: string,
    limit: number | undefined,
    snapshotOptions: RuntimeProviderSnapshotReadOptions = {}
  ): Promise<RuntimeTerminalProjection> {
    return this.terminalOutput.readProviderTerminalTailLines(ptyId, limit, snapshotOptions)
  }
}
