import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type * as ProcessHost from '@orca/process-host'
import { alive, createSupervisedProbeRig, waitFor, type SupervisedProbeRig } from '../codex/supervised-probe-owner.test-fixture'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { PROVIDER_GROUP_WATCHDOG_SCRIPT } from './provider-group-watchdog'

vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHost>()
  return { ...actual, spawnProcess: vi.fn(actual.spawnProcess) }
})

let rig: SupervisedProbeRig | null = null
const recordedPids: number[] = []
afterEach(() => {
  vi.mocked(spawnProcess).mockRestore()
  for (const pid of recordedPids.splice(0)) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  rig?.cleanup()
  rig = null
})

describe.runIf(process.platform !== 'win32')('protected provider exec', () => {
  it('never executes a provider when its owner dies between spawn and adoption', async () => {
    rig = createSupervisedProbeRig()
    const provider = rig.writeStandIn('agent')
    const source = `
      import { writeFileSync } from 'node:fs'
      import { spawnProcess } from '@orca/process-host'
import type * as ProcessHost from '@orca/process-host'
      import { createProviderSpawnSpec } from './provider-process-group'
      const spec = createProviderSpawnSpec({ command: process.env.ORCA_TEST_STAND_IN!, args: [] }, process.env, process.platform)
      const child = spawnProcess({ program: spec.program, args: spec.args, env: spec.env,
        detached: spec.detached, stdio: ['pipe', 'pipe', 'pipe', ...spec.extraStdio] })
      writeFileSync(process.env.ORCA_TEST_PID_FILE! + '.gate', String(child.pid))
      process.kill(process.pid, 'SIGKILL')
    `
    const owner = rig.launchOwner(await rig.bundleOwner(source, __dirname), {
      ORCA_TEST_STAND_IN: provider
    })
    await new Promise<void>((resolve) => owner.once('exit', () => resolve()))
    const gatePid = Number(readFileSync(`${rig.pidFile}.gate`, 'utf8'))
    recordedPids.push(gatePid)
    expect(await waitFor(() => !alive(gatePid), 5_000)).toBe(true)
    expect(existsSync(rig.pidFile)).toBe(false)
  })

  it.each(['spawn-error', 'early-exit'] as const)('aborts exec on watcher %s', async (failure) => {
    rig = createSupervisedProbeRig()
    const actual = await vi.importActual<typeof ProcessHost>('@orca/process-host')
    vi.mocked(spawnProcess).mockImplementation((spec) => actual.spawnProcess(
      spec.args?.[1] === PROVIDER_GROUP_WATCHDOG_SCRIPT
        ? { ...spec, program: failure === 'spawn-error' ? join(rig!.dir, 'missing-watcher') : '/bin/sh', args: ['-c', 'exit 1'] }
        : spec
    ))
    const managed = spawnManagedProviderProcess({
      command: rig.writeStandIn('agent'), args: [], env: rig.env
    }, { site: 'protected-exec-test' })
    if (managed.child.pid) {
      recordedPids.push(managed.child.pid)
    }
    await managed.exitPromise
    expect(existsSync(rig.pidFile)).toBe(false)
    expect(managed.rootExit?.code).not.toBe(0)
  })

  it('retains missing-executable classification through the pre-exec gate', async () => {
    rig = createSupervisedProbeRig()
    const managed = spawnManagedProviderProcess({ command: join(rig.dir, 'missing-provider'), args: [] }, {
      site: 'protected-exec-missing-test'
    })
    if (managed.child.pid) {
      recordedPids.push(managed.child.pid)
    }
    await managed.exitPromise
    expect(managed.executableMissing).toBe(true)
  })
})
