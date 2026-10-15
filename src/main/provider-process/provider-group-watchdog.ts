import { Socket } from 'node:net'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'

/** Time the provider gets to exit on its own after its stdin ends, before SIGTERM. */
export const PROVIDER_STDIN_END_GRACE_MS = 1_000
/** Time the provider group gets to flush and exit after SIGTERM, before SIGKILL. */
export const PROVIDER_SIGTERM_GRACE_MS = 3_000
/**
 * How long a stop waits for a SIGKILLed group to disappear. A killed process never runs again, so
 * this only covers the kernel finishing the kill; waiting forever could hang close or recovery on a
 * process stuck in the kernel, such as one blocked on a hung network drive.
 */
export const PROVIDER_GROUP_REAP_TIMEOUT_MS = 1_500
/** Longest a provider group stop takes (stdin end, grace, SIGTERM, grace, SIGKILL, reap). */
export const PROVIDER_GROUP_MAX_STOP_MS =
  PROVIDER_STDIN_END_GRACE_MS + PROVIDER_SIGTERM_GRACE_MS + PROVIDER_GROUP_REAP_TIMEOUT_MS

/**
 * What the watchdog does to a group once its owner is gone. `drain`: the provider already saw its
 * stdin end, so it gets the stdin-end grace first. `stop`: SIGTERM at once. `one-shot`: SIGTERM at
 * once, and the rest of the group is killed as soon as the provider itself has exited.
 */
export type ProviderGroupOwnerDeathStop = 'drain' | 'stop' | 'one-shot'

const TICK_MS = 100
const ticks = (ms: number): number => Math.ceil(ms / TICK_MS)
const DRAIN = ticks(PROVIDER_STDIN_END_GRACE_MS)
const TERM = ticks(PROVIDER_SIGTERM_GRACE_MS)
const LAST_TICK = DRAIN + TERM + ticks(PROVIDER_GROUP_REAP_TIMEOUT_MS)

/**
 * One `sh` per Orca process, blocked in `read` until Orca's end of its stdin closes, which the
 * kernel does however Orca exits. Each `+ <pgid> <mode>` names a group Orca leads; `- <pgid>` one
 * that is gone. A group is signalled only while continuously alive since EOF, and only if its
 * leader pid is gone (a live pgid is never reused) or still the process registered.
 */
export const PROVIDER_GROUP_WATCHDOG_SCRIPT = `
trap '' PIPE
groups=' '
procfs=
[ -r /proc/self/stat ] && procfs=1
# Sets st to the process's start time, or empty when it is gone; procfs needs no fork.
started() {
  st=
  if [ -n "$procfs" ]; then
    read -r st 2>/dev/null < /proc/$1/stat || return 0
    st=\${st##*) }
    set -- $st
    st=\${20}
  else
    st=$(ps -o lstart= -p $1 2>/dev/null)
  fi
}
add() {
  started $1
  [ -n "$st" ] || return 1
  case "$groups" in *" $1 "*) ;; *) groups="$groups$1 " ;; esac
  eval "mode_$1=\\$2; start_$1=\\$st"
}
remove() {
  case "$groups" in *" $1 "*) groups="\${groups%% $1 *} \${groups#* $1 }" ;; esac
  unset mode_$1 start_$1
}
ours() {
  started $1
  eval "[ -z \\"\\$st\\" ] || [ \\"\\$st\\" = \\"\\$start_$1\\" ]"
}
alive() { kill -s 0 -- -$1 2>/dev/null; }
leader() { kill -s 0 $1 2>/dev/null; }
signal() { kill -s $1 -- -$2 2>/dev/null; }
while read -r op pgid mode; do
  case $pgid in ''|*[!0-9]*|0|1) continue ;; esac
  case $op in
    +) case $mode in drain|stop|one-shot) add $pgid $mode && printf '%s\\n' "$pgid" ;; esac ;;
    -) remove $pgid ;;
  esac
done
live=
for g in $groups; do ours $g && live="$live $g"; done
tick=0
while [ -n "$live" ]; do
  next=
  for g in $live; do
    alive $g || continue
    next="$next $g"
    eval "mode=\\$mode_$g"
    case $mode in
      drain)
        if [ $tick -lt ${DRAIN} ]; then leader $g || signal KILL $g
        elif [ $tick -eq ${DRAIN} ]; then signal TERM $g
        elif [ $tick -ge ${DRAIN + TERM} ]; then signal KILL $g; fi ;;
      stop)
        [ $tick -eq 0 ] && signal TERM $g
        [ $tick -ge ${TERM} ] && signal KILL $g ;;
      one-shot)
        [ $tick -eq 0 ] && signal TERM $g
        if [ $tick -ge ${TERM} ] || ! leader $g; then signal KILL $g; fi ;;
    esac
  done
  live=$next
  [ $tick -ge ${LAST_TICK} ] && exit 1
  sleep ${TICK_MS / 1000}
  tick=$((tick + 1))
done
`

/** The watchdog's launch: a fixed PATH and C locale keep `ps` and its start-time text stable. */
export function providerGroupWatchdogLaunch(): {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
} {
  return {
    command: '/bin/sh',
    args: ['-c', PROVIDER_GROUP_WATCHDOG_SCRIPT],
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }
  }
}

const REGISTRATION_TIMEOUT_MS = 5_000

type WatchedGroup = {
  ready: () => void
  failed: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}
type Watchdog = { child: ChildProcessHandle; groups: Map<number, WatchedGroup> }
let watchdog: Watchdog | null = null

function failWatchdog(current: Watchdog, error: Error): void {
  if (watchdog !== current) return
  watchdog = null
  current.child.stdin?.destroy()
  for (const group of current.groups.values()) {
    if (group.timer) clearTimeout(group.timer)
    group.failed(error)
  }
  current.groups.clear()
}

function startWatchdog(): Watchdog {
  const launch = providerGroupWatchdogLaunch()
  const child = spawnProcess({
    program: launch.command,
    args: launch.args,
    env: launch.env,
    // Only Orca holds the write end, so its death is always EOF.
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true
  })
  const current: Watchdog = { child, groups: new Map() }
  watchdog = current
  const fail = (error: Error): void => failWatchdog(current, error)
  child.on('error', fail)
  child.stdin?.on('error', fail)
  child.once('exit', () => fail(new Error('Provider cleanup watcher exited')))
  let pending = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    pending += chunk
    let end: number
    while ((end = pending.indexOf('\n')) !== -1) {
      const pgid = Number(pending.slice(0, end))
      pending = pending.slice(end + 1)
      const group = current.groups.get(pgid)
      if (group?.timer) {
        clearTimeout(group.timer)
        group.timer = null
        group.ready()
      }
    }
    if (pending.length > 64) fail(new Error('Invalid provider cleanup acknowledgement'))
  })
  child.unref()
  for (const pipe of [child.stdin, child.stdout]) {
    if (pipe instanceof Socket) pipe.unref()
  }
  if (child.pid === undefined || !child.stdin || !child.stdout) {
    queueMicrotask(() => fail(new Error('Provider cleanup watcher could not start')))
  }
  return current
}

/** The caller keeps exec gated until the surviving watcher acknowledges ownership. */
export function watchProviderGroup(
  pgid: number,
  stop: ProviderGroupOwnerDeathStop,
  ready: () => void,
  failed: (error: Error) => void
): () => void {
  let current: Watchdog
  try {
    current = watchdog ?? startWatchdog()
  } catch (error) {
    queueMicrotask(() => failed(error instanceof Error ? error : new Error(String(error))))
    return () => {}
  }
  const group: WatchedGroup = { ready, failed, timer: null }
  current.groups.set(pgid, group)
  group.timer = setTimeout(
    () => failWatchdog(current, new Error('Provider cleanup watcher did not acknowledge launch')),
    REGISTRATION_TIMEOUT_MS
  )
  current.child.stdin?.write(`+ ${pgid} ${stop}\n`)
  return () => {
    if (group.timer) clearTimeout(group.timer)
    if (current.groups.delete(pgid)) current.child.stdin?.write(`- ${pgid}\n`)
  }
}
