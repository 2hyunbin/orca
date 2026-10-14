import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { DISCONNECTED_PTY_RECORD_MAX } from './orca-runtime-postlude'

const WORKSPACE = 'folder-headless-pruning'
const OUTPUT = `${'archived terminal output '.repeat(3)}\r\n`.repeat(60)

class ArchiveRuntime extends OrcaRuntimeService {
  counts() {
    return {
      records: this.ptysById.size,
      models: this.headlessTerminals.size,
      hydration: this.headlessHydrationState.size
    }
  }

  hasModel(ptyId: string): boolean {
    return this.headlessTerminals.has(ptyId)
  }

  model(ptyId: string) {
    const model = this.headlessTerminals.get(ptyId)
    if (!model) {
      throw new Error(`Missing headless model: ${ptyId}`)
    }
    return model
  }

  async settleModels(): Promise<void> {
    await Promise.all([...this.headlessTerminals.values()].map((model) => model.writeChain))
  }

  async refreshInventory(): Promise<void> {
    await this.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      undefined,
      false,
      {
        refreshForegroundAgents: false
      }
    )
  }

  async releaseModels(): Promise<void> {
    const models = [...this.headlessTerminals.values()]
    for (const ptyId of this.headlessTerminals.keys()) {
      this.onPtyExit(ptyId, 0)
    }
    await Promise.all(models.map((model) => model.writeChain))
  }
}

const runtimes: ArchiveRuntime[] = []

function createRuntime(livePtyIds: readonly string[] = []): ArchiveRuntime {
  const runtime = new ArchiveRuntime()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => ({ cols: 80, rows: 24 }),
    hasPty: (ptyId) => livePtyIds.includes(ptyId),
    listProcesses: async () => livePtyIds.map((id) => ({ id, cwd: '', title: 'terminal' }))
  })
  runtimes.push(runtime)
  return runtime
}

function ingest(runtime: ArchiveRuntime, ptyId: string): void {
  runtime.registerPty(ptyId, WORKSPACE)
  runtime.onPtyData(ptyId, OUTPUT, OUTPUT.length)
  runtime.onPtyData(ptyId, 'last output\r\n', OUTPUT.length + 13)
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.releaseModels()
  }
  vi.restoreAllMocks()
})

describe('disconnected terminal model archive', () => {
  it('bounds real headless models when inventory reconciles missed exit callbacks', async () => {
    const runtime = createRuntime()
    const disposed = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    for (let round = 0; round < 3; round += 1) {
      for (let index = 0; index < DISCONNECTED_PTY_RECORD_MAX; index += 1) {
        ingest(runtime, `missed-exit-${round}-${index}`)
      }
      await runtime.settleModels()
      await runtime.refreshInventory()
      await Promise.resolve()

      expect(runtime.counts()).toEqual({
        records: DISCONNECTED_PTY_RECORD_MAX,
        models: DISCONNECTED_PTY_RECORD_MAX,
        hydration: DISCONNECTED_PTY_RECORD_MAX
      })
      expect(disposed).toHaveBeenCalledTimes(round * DISCONNECTED_PTY_RECORD_MAX)
      expect(runtime.hasModel(`missed-exit-${round}-0`)).toBe(true)
      if (round > 0) {
        expect(runtime.hasModel(`missed-exit-${round - 1}-0`)).toBe(false)
      }
    }
  })

  it('releases one missed-exit model as later normal exits turn over the archive', async () => {
    const runtime = createRuntime()
    ingest(runtime, 'one-missed-exit')
    await runtime.settleModels()
    await runtime.refreshInventory()
    expect(runtime.hasModel('one-missed-exit')).toBe(true)

    for (let index = 0; index < DISCONNECTED_PTY_RECORD_MAX; index += 1) {
      const ptyId = `normal-exit-${index}`
      runtime.registerPty(ptyId, WORKSPACE)
      runtime.onPtyData(ptyId, 'shell prompt\r\n', 14)
    }
    await runtime.settleModels()
    for (let index = 0; index < DISCONNECTED_PTY_RECORD_MAX; index += 1) {
      runtime.onPtyExit(`normal-exit-${index}`, 0)
    }
    await Promise.resolve()

    expect(runtime.hasModel('one-missed-exit')).toBe(false)
    expect(runtime.counts()).toEqual({
      records: DISCONNECTED_PTY_RECORD_MAX,
      models: 0,
      hydration: 0
    })
  })

  it('keeps live and leaf-bound models while evicting the oldest disconnected archive', async () => {
    const runtime = createRuntime(['still-live'])
    ingest(runtime, 'still-live')
    ingest(runtime, 'still-mounted')
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-mounted',
          worktreeId: WORKSPACE,
          title: 'Terminal',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-mounted',
          worktreeId: WORKSPACE,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'still-mounted'
        }
      ]
    })
    for (let index = 0; index <= DISCONNECTED_PTY_RECORD_MAX; index += 1) {
      ingest(runtime, `archive-${index}`)
    }
    await runtime.settleModels()
    await runtime.refreshInventory()

    expect(runtime.hasModel('archive-0')).toBe(false)
    expect(runtime.hasModel(`archive-${DISCONNECTED_PTY_RECORD_MAX}`)).toBe(true)
    expect(runtime.hasModel('still-live')).toBe(true)
    expect(runtime.hasModel('still-mounted')).toBe(true)
    expect(runtime.counts().models).toBe(DISCONNECTED_PTY_RECORD_MAX + 2)
    const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer(
      `archive-${DISCONNECTED_PTY_RECORD_MAX}`
    )
    expect(`${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`).toContain('last output')
  })

  it('finishes queued output before disposal and gives a same-ID successor a fresh model', async () => {
    const runtime = createRuntime()
    const ptyId = 'queued-pruned-terminal'
    runtime.registerPty(ptyId, WORKSPACE)
    runtime.onPtyData(ptyId, 'queued predecessor\r\n', 20)
    const old = runtime.model(ptyId)
    const write = old.emulator.write.bind(old.emulator)
    const events: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(old.emulator, 'write').mockImplementationOnce(async (data, options) => {
      await held
      await write(data, options)
      events.push('old-write')
    })
    const disabled = vi.spyOn(old.emulator, 'disableQueryReplyForwarding')
    const dispose = old.emulator.dispose.bind(old.emulator)
    vi.spyOn(old.emulator, 'dispose').mockImplementation(() => {
      events.push('old-dispose')
      dispose()
    })
    try {
      for (let index = 0; index < DISCONNECTED_PTY_RECORD_MAX; index += 1) {
        runtime.registerPty(`queued-archive-${index}`, WORKSPACE)
      }
      await runtime.refreshInventory()
      expect(runtime.hasModel(ptyId)).toBe(false)
      expect(disabled).toHaveBeenCalledOnce()
      expect(events).toEqual([])

      ingest(runtime, ptyId)
      await runtime.settleModels()
      expect(runtime.model(ptyId)).not.toBe(old)
      release()
      await old.writeChain
      await Promise.resolve()
      expect(events).toEqual(['old-write', 'old-dispose'])
      const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer(ptyId)
      const text = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
      expect(text).toContain('last output')
      expect(text).not.toContain('queued predecessor')
    } finally {
      release()
      await old.writeChain
    }
  })
})
