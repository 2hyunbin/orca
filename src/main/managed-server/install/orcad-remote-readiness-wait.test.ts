import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { orcadReadinessWaitCommand } from './orcad-remote-readiness-wait'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('the host-side readiness wait', () => {
  it('ends by its wall-clock deadline however slow each poll is', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-readiness-wait-'))
    roots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
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
    // Counted polling would take about 8 × (0.25 s + 1 s), exceeding the client timeout.
    expect(Date.now() - startedAt).toBeLessThan(4_500)
  })
})
