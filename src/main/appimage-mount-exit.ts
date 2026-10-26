// The AppImage runtime unmounts once every holder of its keepalive pipe exits; on-mount helpers
// still exiting after main then SIGBUS. Kill Crashpad, and lend the pipe to an off-mount watcher.
// Main-process crashes bypass exit hooks, so the handler may still fault after writing the dump.

import { spawn } from 'node:child_process'
import { readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
// posix: /proc paths are Linux-only, and tests run this matcher on every host.
import { posix } from 'node:path'
import { resolveAppImageRuntimeIdentity } from './appimage-runtime-identity'

const HELPER_EXIT_GRACE_TICKS = 50

// Builtins only besides sleep: wait ~5s for helpers still on the mount, then SIGKILL survivors.
// `-ef` rechecks each pid's exe so a reused pid is neither waited for nor killed.
const MOUNT_KEEPALIVE_SCRIPT = `alive() { for h; do [ /proc/"\${h%%=*}"/exe -ef "\${h#*=}" ] && return 0; done; return 1; }
n=0
while [ $n -lt ${HELPER_EXIT_GRACE_TICKS} ] && alive "$@"; do sleep 0.1 || exit; n=$((n+1)); done
for h; do [ /proc/"\${h%%=*}"/exe -ef "\${h#*=}" ] && kill -9 "\${h%%=*}"; done`

function listPids(): number[] {
  try {
    return readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
  } catch {
    return []
  }
}

function readLink(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

function listFdLinks(fdDir: string): [fd: number, link: string][] {
  try {
    return readdirSync(fdDir).flatMap<[number, string]>((fd) => {
      const link = readLink(`${fdDir}/${fd}`)
      return link ? [[Number(fd), link]] : []
    })
  } catch {
    return []
  }
}

// Extract-and-run reuses one digest-named dir across concurrent launches and has no FUSE mount to lose.
function isRunningFromOwnMount(runtimeRoot: string): boolean {
  try {
    return statSync(runtimeRoot).dev !== statSync(posix.dirname(runtimeRoot)).dev
  } catch {
    return false
  }
}

// type2-runtime keeps the FUSE server alive while any read end of a pipe it writes to stays open.
function findKeepaliveFd(serverPids: number[]): number | null {
  const serverPipes = new Set(
    serverPids.flatMap((pid) =>
      listFdLinks(`/proc/${pid}/fd`)
        .map(([, link]) => link)
        .filter((link) => link.startsWith('pipe:'))
    )
  )
  return listFdLinks('/proc/self/fd').find(([, link]) => serverPipes.has(link))?.[0] ?? null
}

/** Use Node's final exit phase because Electron can defer will-quit. */
export function installAppImageMountExit(): void {
  const runtimeRoot = posix.dirname(process.execPath)
  const identity = resolveAppImageRuntimeIdentity()
  // Validate now because the AppImage may be moved or deleted before exit.
  if (!identity || !isRunningFromOwnMount(runtimeRoot)) {
    return
  }
  let appImagePath: string
  try {
    appImagePath = realpathSync(identity.appImagePath)
  } catch {
    return
  }
  const handlerPath = posix.join(runtimeRoot, 'chrome_crashpad_handler')
  process.once('exit', () => {
    const helpers: string[] = []
    const serverPids: number[] = []
    for (const pid of listPids()) {
      const executable = readLink(`/proc/${pid}/exe`)
      if (executable === appImagePath) {
        serverPids.push(pid)
      } else if (executable === handlerPath) {
        try {
          // SIGTERM runs handler code that may fault as FUSE unmounts; SIGKILL does not.
          process.kill(pid, 'SIGKILL')
        } catch {
          // The handler may already have exited.
        }
      } else if (pid !== process.pid && executable?.startsWith(`${runtimeRoot}/`)) {
        helpers.push(`${pid}=${executable}`)
      }
    }
    const keepaliveFd = helpers.length > 0 ? findKeepaliveFd(serverPids) : null
    if (keepaliveFd === null) {
      return
    }
    try {
      spawn(
        '/bin/sh',
        ['-c', MOUNT_KEEPALIVE_SCRIPT, 'orca-appimage-mount-keepalive', ...helpers],
        {
          cwd: '/',
          // AppRun points PATH and LD_LIBRARY_PATH into the mount this watcher must not depend on.
          env: { PATH: '/usr/bin:/bin' },
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore', keepaliveFd]
        }
      ).unref()
    } catch {
      // Without a watcher the runtime unmounts when main exits, as before.
    }
  })
}
