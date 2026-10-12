import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'

const enabled = process.platform === 'win32' && process.env.ORCA_WINDOWS_ADMIN_TERMINAL_TEST === '1'

// Opt in only from an already elevated verification shell; never display UAC during tests.
it.skipIf(!enabled)(
  'detaches captured handles and refuses to secure another host’s pipe',
  async () => {
    const launcher = join(process.cwd(), 'native', 'windows-cli-launcher', '.build', 'orca.exe')
    const check = await runProcess({ program: launcher, args: ['--orca-check-administrator'] })
    expect(JSON.parse(check.stdout)).toEqual({ elevated: true })
    // The broker elevates only this checkout's runtime, so the host and scripts live inside it.
    const electron = String(createRequire(import.meta.url)('electron'))
    const directory = mkdtempSync(join(launcher, '..', 'orca admin 雪 '))
    const entry = join(directory, 'pipe-server.cjs')
    const pidPath = join(directory, 'server-pid.txt')
    const idleEntry = join(directory, 'idle-server.cjs')
    const socket = `\\\\?\\pipe\\orca-terminal-host-test-${randomUUID()}`
    writeFileSync(
      entry,
      `const net=require('node:net'),fs=require('node:fs');
const socket=process.argv[process.argv.indexOf('--socket')+1];
const server=net.createServer(client=>{
  client.on('error',()=>{});
  client.on('data',chunk=>client.write(chunk));
});
server.listen(socket,()=>fs.writeFileSync('server-pid.txt',String(process.pid)));
setTimeout(()=>process.exit(1),30000).unref();`
    )
    writeFileSync(idleEntry, 'setTimeout(()=>process.exit(1),30000)')
    const launch = (script = entry, program = electron) =>
      runProcess({
        program: launcher,
        args: ['--orca-admin-terminal-host', program, script, directory, '--socket', socket],
        timeoutMs: 10_000
      })
    let hostPid: number | undefined
    try {
      const foreign = await launch(entry, process.execPath)
      expect(foreign).toMatchObject({ code: 1, timedOut: false })
      expect(foreign.stderr).toContain('must be this Orca installation')
      const first = await launch()
      expect(first).toMatchObject({ code: 0, timedOut: false })
      const pid = Number(readFileSync(pidPath, 'utf8'))
      expect(pid).toBeGreaterThan(0)
      hostPid = pid
      const conflicting = await launch(idleEntry)
      expect(conflicting).toMatchObject({ code: 1, timedOut: false })
      expect(conflicting.stderr).toContain('not owned by the launched terminal host')
      expect((await launch(idleEntry)).stderr).toContain('not owned by the launched terminal host')
    } finally {
      if (hostPid !== undefined) {
        await runProcess({
          program: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          args: ['/PID', String(hostPid), '/F']
        })
      }
      rmSync(directory, { recursive: true, force: true })
    }
  },
  25_000
)
