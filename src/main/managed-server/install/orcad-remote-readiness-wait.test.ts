import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { orcadReadinessWaitCommand } from './orcad-remote-readiness-wait'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// BUG-17: under host load each poll's reads outlasted its sleep, so a counted loop ran past the
// client's 30 s exec timeout and the launch was failed while the candidate was still starting.
describe.skipIf(process.platform === 'win32')('the host-side readiness wait', () => {
  it('ends by its wall-clock deadline however slow each poll is', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-readiness-wait-'))
    roots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    // A host where every `wc` takes half a second.
    writeFileSync(join(bin, 'wc'), '#!/bin/sh\nsleep 0.5\nexec /usr/bin/wc "$@"\n')
    chmodSync(join(bin, 'wc'), 0o755)
    const slot = join(root, 'slot')
    mkdirSync(slot)
    const command = orcadReadinessWaitCommand(getRemoteHostPlatform('linux-x64'), slot, 2)
    const startedAt = Date.now()
    await runProcess({
      program: '/bin/sh',
      args: ['-c', command],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      timeoutMs: 30_000
    })
    // A counted loop would take about 8 x (0.25 s + 1 s) here.
    expect(Date.now() - startedAt).toBeLessThan(4_500)
  })

  // The wait ends only on an exit the host proved; a live or unnamed PID waits out its deadline.
  it.each([
    ['ends at once when the launched PID is gone', true],
    ['waits while the launched PID still runs', false]
  ])('%s', async (_case, exited) => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-readiness-wait-'))
    roots.push(root)
    const slot = join(root, 'slot')
    mkdirSync(slot)
    const pidFile = join(slot, '.orcad-pid')
    const command = orcadReadinessWaitCommand(getRemoteHostPlatform('linux-x64'), slot, 2)
    const prefix = exited
      ? `sh -c 'echo $$ > "$1"' orcad-test ${quotePosixShell(pidFile)};`
      : `echo ${process.pid} > ${quotePosixShell(pidFile)};`
    const { stdout } = await runProcess({
      program: '/bin/sh',
      args: ['-c', `${prefix} ${command}`],
      timeoutMs: 30_000
    })
    expect(stdout.startsWith('ORCAD_LAUNCH_EXITED\n')).toBe(exited)
  })
})
