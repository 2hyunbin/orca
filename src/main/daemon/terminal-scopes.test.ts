import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parsePtyProcessCeiling,
  PTY_PROCESS_CEILING_ENV,
  resolveTerminalScopes,
  type TerminalScopeRuntime
} from './terminal-scopes'
import {
  currentPtyProcessCeiling,
  setTerminalScopesForTest,
  wrapPtySpawnInTerminalScope
} from './terminal-scopes-runtime'
import {
  confirmPtyProcessCeiling,
  describePtyProcessCeiling,
  parsePtyProcessCeilingState
} from '../../shared/pty-process-ceiling-state'
import { parseDaemonPidFile } from './daemon-pid-file-parse'

const SLICE_CGROUP = '/user.slice/user-1000.slice/user@1000.service/orca_ptys_1f_2e.slice'

type Call = { program: string; args: string[] }

/** A user manager that may reject OOMPolicy on scopes and enforces `pidsMax` on each one. */
function fakeManager({ oomPolicy = true, pidsMax = 'max', sliceStarts = true } = {}) {
  const calls: Call[] = []
  const run = vi.fn((program: string, args: string[]) => {
    calls.push({ program, args })
    if (program === 'busctl') {
      return { code: sliceStarts ? 0 : 1, timedOut: false, stdout: '' }
    }
    if (program === '/usr/bin/systemd-run') {
      const rejected = !oomPolicy && args.includes('--property=OOMPolicy=continue')
      return rejected
        ? { code: 1, timedOut: false, stdout: '' }
        : { code: 0, timedOut: false, stdout: `0::${SLICE_CGROUP}/run-r1.scope\n${pidsMax}\n` }
    }
    return { code: 0, timedOut: false, stdout: '' }
  })
  return { calls, run }
}

function linuxInput(
  manager: ReturnType<typeof fakeManager>,
  overrides: Partial<Parameters<typeof resolveTerminalScopes>[0]> = {}
): Parameters<typeof resolveTerminalScopes>[0] {
  return {
    env: {},
    platform: 'linux',
    launchId: '1f-2e',
    daemonScope: 'orca-daemon-1f-2e.scope',
    unifiedCgroup: () => true,
    findExecutable: (name: string) => `/usr/bin/${name}`,
    run: manager.run,
    ...overrides
  }
}

describe('resolveTerminalScopes', () => {
  it('is on by default in the daemon’s own scope, with the slice bound to that scope', () => {
    const manager = fakeManager()
    const resolved = resolveTerminalScopes(linuxInput(manager))
    expect(resolved.ceiling).toEqual({ state: 'off', reason: 'disabled' })
    expect(resolved.linux).toEqual({
      slice: 'orca_ptys_1f_2e.slice',
      sliceCgroupPath: `/sys/fs/cgroup${SLICE_CGROUP}`,
      systemdRun: '/usr/bin/systemd-run',
      envBinary: '/usr/bin/env',
      launchId: '1f_2e',
      properties: ['OOMPolicy=continue', 'TimeoutStopSec=5s']
    })
    expect(manager.calls[0]?.args).toEqual(
      expect.arrayContaining([
        'orca_ptys_1f_2e.slice',
        'BindsTo',
        'After',
        'orca-daemon-1f-2e.scope'
      ])
    )
    expect(manager.calls[1]?.args).toEqual(
      expect.arrayContaining(['--slice=orca_ptys_1f_2e.slice', '--property=OOMPolicy=continue'])
    )
    expect(manager.calls[2]?.args).toEqual([
      '--user',
      'set-property',
      '--runtime',
      'orca-daemon-1f-2e.scope',
      'ManagedOOMPreference=avoid'
    ])
  })

  it('drops only OOMPolicy where scopes reject it (systemd before 253)', () => {
    const manager = fakeManager({ oomPolicy: false })
    const resolved = resolveTerminalScopes(linuxInput(manager))
    expect(resolved.linux?.properties).toEqual(['TimeoutStopSec=5s'])
    expect(manager.calls.filter((call) => call.program === '/usr/bin/systemd-run')).toHaveLength(2)
  })

  it.each([
    ['no owned daemon scope', { daemonScope: null }, 'no_user_manager'],
    ['cgroup v1 or hybrid', { unifiedCgroup: () => false }, 'no_user_manager'],
    [
      'no env binary',
      { findExecutable: (name: string) => (name === 'env' ? null : `/usr/bin/${name}`) },
      'systemd_run_missing'
    ],
    ['macOS', { platform: 'darwin' as const }, 'unsupported_platform']
  ])('stays off with %s, without touching the user manager', (_label, overrides, reason) => {
    const manager = fakeManager()
    const resolved = resolveTerminalScopes(linuxInput(manager, overrides))
    expect(resolved).toEqual({
      ceiling: { state: 'off', reason: 'disabled' },
      linux: null,
      offReason: reason
    })
    expect(manager.run).not.toHaveBeenCalled()
  })

  it('stays off when the slice cannot start, or removes it when no probe scope starts', () => {
    expect(resolveTerminalScopes(linuxInput(fakeManager({ sliceStarts: false }))).offReason).toBe(
      'slice_unavailable'
    )
    const run = vi.fn((program: string, _args: string[]) => ({
      code: program === 'busctl' || program === 'systemctl' ? 0 : 1,
      timedOut: false,
      stdout: ''
    }))
    const resolved = resolveTerminalScopes(linuxInput({ calls: [], run }))
    expect(resolved).toMatchObject({ linux: null, offReason: 'slice_unavailable' })
    expect(run.mock.calls.at(-1)?.[1]).toEqual([
      '--user',
      '--no-block',
      'stop',
      'orca_ptys_1f_2e.slice'
    ])
  })

  it('puts the process ceiling on each terminal scope once the kernel shows it', () => {
    const env = { [PTY_PROCESS_CEILING_ENV]: '2048' }
    const resolved = resolveTerminalScopes(linuxInput(fakeManager({ pidsMax: '2048' }), { env }))
    expect(resolved.ceiling).toEqual({
      state: 'on',
      limit: 2048,
      mechanism: 'systemd-slice',
      unit: 'orca_ptys_1f_2e.slice',
      controlGroup: SLICE_CGROUP
    })
    expect(resolved.linux?.properties).toEqual([
      'OOMPolicy=continue',
      'TimeoutStopSec=5s',
      'TasksMax=2048'
    ])
  })

  it('keeps terminal scopes but reports the ceiling off when TasksMax is not enforced', () => {
    const env = { [PTY_PROCESS_CEILING_ENV]: '2048' }
    const resolved = resolveTerminalScopes(linuxInput(fakeManager({ pidsMax: 'max' }), { env }))
    expect(resolved.ceiling).toEqual({ state: 'off', reason: 'controller_unavailable' })
    expect(resolved.linux?.properties).toEqual(['OOMPolicy=continue', 'TimeoutStopSec=5s'])
    const missing = resolveTerminalScopes(
      linuxInput(fakeManager(), { env, daemonScope: null })
    ).ceiling
    expect(missing).toEqual({ state: 'off', reason: 'no_user_manager' })
  })

  it('refuses ceilings too small to run a shell, without turning terminal scopes off', () => {
    const env = { [PTY_PROCESS_CEILING_ENV]: '10' }
    const resolved = resolveTerminalScopes(linuxInput(fakeManager(), { env }))
    expect(resolved.ceiling).toEqual({ state: 'off', reason: 'invalid_limit' })
    expect(resolved.linux?.properties).not.toContain('TasksMax=10')
    expect(parsePtyProcessCeiling('0')).toEqual({ kind: 'off' })
  })

  it('uses the per-terminal job limit on Windows only when the native build has it', () => {
    const windows = (
      setWindowsLimit: () => boolean,
      env: NodeJS.ProcessEnv = { [PTY_PROCESS_CEILING_ENV]: '2048' }
    ) =>
      resolveTerminalScopes({
        env,
        platform: 'win32',
        launchId: 'a',
        daemonScope: null,
        setWindowsLimit
      }).ceiling
    expect(windows(() => true)).toEqual({
      state: 'on',
      limit: 2048,
      mechanism: 'windows-job',
      unit: null
    })
    expect(windows(() => false)).toEqual({ state: 'off', reason: 'native_unavailable' })
    expect(windows(() => true, {})).toEqual({ state: 'off', reason: 'disabled' })
  })
})

describe('wrapPtySpawnInTerminalScope', () => {
  const runtime: TerminalScopeRuntime = {
    slice: 'orca_ptys_a.slice',
    sliceCgroupPath: '/sys/fs/cgroup/x/orca_ptys_a.slice',
    systemdRun: '/usr/bin/systemd-run',
    envBinary: '/usr/bin/env',
    launchId: 'a',
    properties: ['OOMPolicy=continue', 'TimeoutStopSec=5s', 'TasksMax=2048']
  }
  const ceilingOn = {
    state: 'on' as const,
    limit: 2048,
    mechanism: 'systemd-slice' as const,
    unit: runtime.slice
  }

  afterEach(() => setTerminalScopesForTest({ state: 'off', reason: 'disabled' }, null))

  it('leaves the spawn untouched while off', () => {
    const env = { TERM: 'xterm' }
    expect(wrapPtySpawnInTerminalScope('/bin/bash', ['-l'], env)).toEqual({
      file: '/bin/bash',
      args: ['-l'],
      env
    })
  })

  it('execs each terminal into its own scope and gives the shell its own session bus back', () => {
    setTerminalScopesForTest(ceilingOn, runtime)
    const spawn = () =>
      wrapPtySpawnInTerminalScope(
        '/bin/bash',
        ['-l'],
        { TERM: 'xterm', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus-x' },
        () => true
      )
    const wrapped = spawn()
    expect(wrapped.file).toBe('/usr/bin/systemd-run')
    const unit = wrapped.args.find((arg) => arg.startsWith('--unit='))
    expect(wrapped.args).toEqual(
      expect.arrayContaining([
        '--user',
        '--scope',
        '--slice=orca_ptys_a.slice',
        '--property=OOMPolicy=continue',
        '--property=TasksMax=2048'
      ])
    )
    expect(spawn().args).not.toContain(unit)
    const command = wrapped.args.slice(wrapped.args.indexOf('--') + 1)
    expect(command[0]).toBe('/usr/bin/env')
    expect(command).toContain('DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-x')
    expect(command.slice(-2)).toEqual(['/bin/bash', '-l'])
    expect(wrapped.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  })

  it('stops wrapping when the slice is gone, reporting a ceiling it had as lost', () => {
    setTerminalScopesForTest(ceilingOn, runtime)
    expect(wrapPtySpawnInTerminalScope('/bin/bash', [], { TERM: 'x' }, () => false).file).toBe(
      '/bin/bash'
    )
    expect(currentPtyProcessCeiling()).toEqual({ state: 'off', reason: 'slice_lost' })
    expect(wrapPtySpawnInTerminalScope('/bin/bash', [], { TERM: 'x' }, () => true).file).toBe(
      '/bin/bash'
    )
    setTerminalScopesForTest({ state: 'off', reason: 'disabled' }, runtime)
    wrapPtySpawnInTerminalScope('/bin/bash', [], { TERM: 'x' }, () => false)
    expect(currentPtyProcessCeiling()).toEqual({ state: 'off', reason: 'disabled' })
  })
})

describe('ceiling report', () => {
  it('reports a slice the user manager dropped as lost, not on', () => {
    const on = {
      state: 'on' as const,
      limit: 2048,
      mechanism: 'systemd-slice' as const,
      unit: 'orca_ptys_a.slice',
      controlGroup: '/u/orca_ptys_a.slice'
    }
    expect(confirmPtyProcessCeiling(on, () => true)).toBe(on)
    expect(confirmPtyProcessCeiling(on, () => false)).toEqual({
      state: 'off',
      reason: 'slice_lost'
    })
    expect(confirmPtyProcessCeiling(null)).toBeNull()
  })

  it('round-trips through the daemon pid record and reads old records as not reported', () => {
    const record = parseDaemonPidFile(
      JSON.stringify({ pid: 7, processCeiling: { state: 'off', reason: 'no_user_manager' } })
    )
    expect(record?.processCeiling).toEqual({ state: 'off', reason: 'no_user_manager' })
    expect(parseDaemonPidFile(JSON.stringify({ pid: 7 }))?.processCeiling).toBeNull()
    expect(parsePtyProcessCeilingState({ state: 'off', reason: 'made-up' })).toBeNull()
    expect(describePtyProcessCeiling(null)).toBe('not reported')
    expect(describePtyProcessCeiling({ state: 'off', reason: 'no_user_manager' })).toBe(
      'off (no user manager)'
    )
  })
})
