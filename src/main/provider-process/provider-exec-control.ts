import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { getSystemErrorName } from 'node:util'
import { spawnProcess } from '@orca/process-host'
import { SearchSubprocessLineAccumulator } from '../../shared/search-subprocess-lines'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { ProviderExecCode } from './provider-exec-code'
import { providerExecChannel } from './provider-exec-channel'
import { resolveProviderChildEnv, type ProviderProcessLaunch } from './provider-process-launch'
import type { ProviderCloseRequest } from './provider-process-supervisor'
import type { ProviderProcessExit } from './managed-provider-process'

type ExecStatus =
  | { kind: 'failed'; stage: string; error: Error }
  | { kind: 'closed' }
  | { kind: 'unverifiable'; error: Error }
type ExecStartup = { kind: 'released'; watcherPid: number } | { kind: 'failed'; error: Error }
type GroupOperation = { group: DescendantTreeVerdict; monotonicMs: number }

/** Unused until signed-owner qualification; policy/reapers/public completion belong to its owner. */
export function spawnProviderExecControl(
  launch: ProviderProcessLaunch,
  code: ProviderExecCode,
  options: {
    closeRequest: ProviderCloseRequest
    inheritedEnv?: NodeJS.ProcessEnv
    onProtectionLost: (error: Error) => void
  }
) {
  const nonce = randomBytes(16).toString('hex')
  const child = spawnProcess({
    program: code.executable,
    args: ['gate', nonce, launch.command, ...launch.args],
    cwd: launch.cwd,
    env: resolveProviderChildEnv(launch, options.inheritedEnv ?? process.env),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', code.holdFd()]
  })
  const physical = Promise.withResolvers<ProviderProcessExit>()
  const execStatus = Promise.withResolvers<ExecStatus>()
  let root: DescendantTreeVerdict = child.pid ? 'live' : 'unverifiable'
  let failure: Error | undefined
  let terminal = false
  let finishing = false
  const gate = child.stdio[3]
  const watcher = child.stdio[4]
  const status = child.stdio[5]
  const loseProtection = (error: Error): void => {
    if (failure || terminal) {
      return
    }
    failure = error
    execStatus.resolve({ kind: 'unverifiable', error })
    gate?.destroy()
    watcher?.destroy()
    options.onProtectionLost(error)
  }
  child.once('exit', (code, signal) => {
    root = 'exited'
    physical.resolve({ code, signal, processless: false })
  })
  child.once('error', (error) => {
    execStatus.resolve({ kind: 'failed', stage: 'spawn', error })
    if (child.pid === undefined) {
      root = 'exited'
      physical.resolve({ code: null, signal: null, processless: true })
    }
    loseProtection(error)
  })
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => {})
  }
  const gateChannel = providerExecChannel(gate, () => {})
  const watchChannel = providerExecChannel(watcher, loseProtection)
  const errors = new SearchSubprocessLineAccumulator(256)
  let statusEnded = false
  let statusReceived = false
  if (!(status instanceof Readable)) {
    loseProtection(new Error('Provider launch endpoint is unavailable'))
  }
  status?.on('data', (chunk: Buffer) => {
    if (
      !errors.push(chunk, (line) => {
        const match = /^ERROR (\w+) ([1-9]\d*)$/.exec(line)
        const errno = Number(match?.[2])
        if (statusReceived || !match || !Number.isSafeInteger(errno) || errno > 4096) {
          loseProtection(new Error('Invalid provider launch status'))
          return
        }
        statusReceived = true
        const error = Object.assign(new Error(`Provider ${match[1]} failed`), {
          errno: -errno,
          code: getSystemErrorName(-errno)
        })
        execStatus.resolve({ kind: 'failed', stage: match[1], error })
      })
    ) {
      loseProtection(new Error('Provider launch status exceeded its bound'))
    }
  })
  status?.once('end', () => {
    statusEnded = true
    if (errors.finish() !== null) {
      loseProtection(new Error('Incomplete provider launch status'))
    }
    execStatus.resolve({ kind: 'closed' })
  })
  status?.once('close', () => {
    if (!statusEnded && !terminal) {
      loseProtection(new Error('Provider launch endpoint closed before EOF'))
    }
  })
  status?.on('error', loseProtection)
  const startup: Promise<ExecStartup> = (async () => {
    const [setup, armed] = await Promise.all([gateChannel.next(), watchChannel.next()])
    const match = new RegExp(`^ARMED ${nonce} ([1-9]\\d*)$`).exec(armed)
    const watcherPid = Number(match?.[1])
    if (
      setup !== `SETUP_COMPLETE ${nonce} ${child.pid}` ||
      !Number.isSafeInteger(watcherPid) ||
      watcherPid <= 1 ||
      watcherPid === child.pid
    ) {
      throw new Error('Provider watcher did not establish protection')
    }
    const phase = options.closeRequest === 'stdin-end' ? 0 : 1
    watchChannel.send(`PHASE ${nonce} ${phase} 0`)
    if ((await watchChannel.next()) !== `PHASE ${nonce} ${phase} 0`) {
      throw new Error('Provider watcher did not accept its close policy')
    }
    if (failure) {
      throw failure
    }
    gateChannel.send(`EXEC ${nonce}`)
    return { kind: 'released', watcherPid }
  })().catch((error: unknown): ExecStartup => {
    const reason = error instanceof Error ? error : new Error(String(error))
    loseProtection(reason)
    return { kind: 'failed', error: reason }
  })
  let tail: Promise<void> = Promise.resolve()
  const request = (command: string, finalReply?: string): Promise<string> => {
    const next = tail.then(async () => {
      const ready = await startup
      if (ready.kind === 'failed') {
        throw ready.error
      }
      if (failure) {
        throw failure
      }
      watchChannel.send(command, finalReply)
      return watchChannel.next()
    })
    tail = next.then(
      () => {},
      () => {}
    )
    return next.catch((error: Error) => {
      loseProtection(error)
      throw error
    })
  }
  const active = (): void => {
    if (finishing) {
      throw new Error('Provider watcher is retiring')
    }
  }
  return {
    child,
    startup,
    rootExit: physical.promise,
    /** A closed errno channel does not prove exec succeeded. */
    execStatus: execStatus.promise,
    get rootVerdict() {
      return root
    },
    operation(command: 'PROBE' | 'TERM' | 'KILL'): Promise<GroupOperation> {
      active()
      return request(`${command} ${nonce}`).then((line) => {
        const match = new RegExp(`^RESULT ${nonce} (-1|0|1) (\\d+)$`).exec(line)
        const monotonicMs = Number(match?.[2])
        if (!match || !Number.isSafeInteger(monotonicMs)) {
          const error = new Error('Invalid provider group observation')
          loseProtection(error)
          throw error
        }
        return {
          group: match[1] === '0' ? 'exited' : match[1] === '1' ? 'live' : 'unverifiable',
          monotonicMs
        }
      })
    },
    acceptPhase(phase: 0 | 1 | 2, deadline: number): Promise<void> {
      active()
      if (!Number.isSafeInteger(deadline) || deadline < 0) {
        throw new RangeError('Invalid provider cleanup deadline')
      }
      const command = `PHASE ${nonce} ${phase} ${deadline}`
      return request(command).then((reply) => {
        if (reply !== command) {
          const error = new Error('Provider cleanup phase was not acknowledged')
          loseProtection(error)
          throw error
        }
      })
    },
    /** RETIRE requires an owner's group-absence proof; ABANDON records an unresolved stop. */
    async finish(command: 'RETIRE' | 'ABANDON'): Promise<void> {
      active()
      finishing = true
      const reply = await request(`${command} ${nonce}`, `RETIRED ${nonce}`)
      if (reply !== `RETIRED ${nonce}`) {
        const error = new Error('Provider watcher did not acknowledge retirement')
        loseProtection(error)
        throw error
      }
      terminal = true
      gateChannel.stop()
      watchChannel.stop()
      status?.destroy()
    },
    disconnect: () => loseProtection(new Error('Provider owner disconnected'))
  }
}

export type ProviderExecControl = ReturnType<typeof spawnProviderExecControl>
