import { spawnProcess } from '@orca/process-host'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  alive,
  createSupervisedProbeRig,
  waitFor,
  type SupervisedProbeRig
} from '../codex/supervised-probe-owner.test-fixture'
import { PROVIDER_GROUP_MAX_STOP_MS, providerGroupWatchdogLaunch } from './provider-group-watchdog'

// Stands in for Orca's main: one host watchdog, three providers spawned one after another (so a
// later one would hold the watchdog's pipe if it leaked), one per way a provider stops.
const OWNER = String.raw`
import { spawnManagedProviderProcess } from './managed-provider-process'
const stops = [
  { lifetime: 'session', closeRequest: 'stdin-end' },
  { lifetime: 'session', closeRequest: 'stdin-end-and-sigterm' },
  { lifetime: 'one-shot', closeRequest: 'stdin-end-and-sigterm' }
] as const
stops.forEach(({ lifetime, closeRequest }, index) => {
  spawnManagedProviderProcess(
    {
      command: process.env.ORCA_TEST_STAND_IN!,
      args: [],
      env: { ORCA_TEST_PID_FILE: process.env.ORCA_TEST_PID_FILE + '.' + index }
    },
    { site: 'watchdog-test', lifetime, policy: { gracefulExitMs: 1_500, forcedExitMs: 1_000, closeRequest } }
  )
})
process.on('SIGUSR2', () => process.exit(0))
setInterval(() => {}, 60_000)
`

let rig: SupervisedProbeRig | null = null
const extraPids: number[] = []

afterEach(() => {
  for (const pid of extraPids.splice(0)) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  rig?.cleanup()
  rig = null
})

describe.runIf(process.platform !== 'win32')('provider group watchdog', () => {
  it('still cleans earlier groups if the owner loses the ACK reader during registration', async () => {
    rig = createSupervisedProbeRig()
    const provider = spawnProcess({ program: rig.writeStandIn('agent'), env: { ...process.env, ...rig.env }, detached: true })
    const pids = await rig.readPids()
    const launch = providerGroupWatchdogLaunch()
    const watcher = spawnProcess({ program: launch.command, args: launch.args, env: launch.env, detached: true })
    if (watcher.pid) extraPids.push(watcher.pid)
    // Reader closure deterministically makes the pending registration's ACK fail with EPIPE.
    watcher.stdout.destroy()
    watcher.stdin.on('error', () => {})
    watcher.stdin.end(`+ ${pids.provider} stop\n`)
    expect(await waitFor(() => !alive(pids.provider) && !alive(pids.grandchild), PROVIDER_GROUP_MAX_STOP_MS + 1_000)).toBe(true)
    await new Promise<void>((resolve) => {
      if (provider.exitCode !== null || provider.signalCode !== null) resolve()
      else provider.once('exit', () => resolve())
    })
  })

  it.each([
    ['is SIGKILLed', 'SIGKILL'],
    ['quits', 'SIGUSR2']
  ] as const)('stops every provider group when Orca %s', async (_, signal) => {
    rig = createSupervisedProbeRig()
    const standIn = rig.writeStandIn('agent')
    const owner = rig.launchOwner(await rig.bundleOwner(OWNER, __dirname), {
      ORCA_TEST_STAND_IN: standIn
    })
    const pidFiles = [0, 1, 2].map((index) => `${rig!.pidFile}.${index}`)
    expect(await waitFor(() => pidFiles.every((file) => existsSync(file)), 20_000)).toBe(true)
    const pids = pidFiles.flatMap((file): number[] => {
      const { provider, grandchild } = JSON.parse(readFileSync(file, 'utf8'))
      return [provider, grandchild]
    })
    extraPids.push(...pids)
    expect(pids.every(alive)).toBe(true)

    owner.kill(signal)

    // Each grandchild ignores SIGTERM, so only the watchdog's group SIGKILL ends it.
    expect(await waitFor(() => !pids.some(alive), PROVIDER_GROUP_MAX_STOP_MS + 1_000)).toBe(true)
  })
})
