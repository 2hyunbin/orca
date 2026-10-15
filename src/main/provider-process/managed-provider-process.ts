import type { PipedChildProcess, PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { RetryableProcessExitProof } from '@orca/process-host/retryable-process-exit-proof'
import type { ProviderProcessLaunch } from './provider-process-launch'
import {
  createProviderSpawnSpec,
  type ProviderCloseRequest,
  type ProviderProcessLifetime
} from './provider-process-group'
import {
  terminateProviderProcessTree,
  type ProviderProcessTeardownVerdict
} from './provider-process-teardown'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { isMissingProviderExecutable } from './provider-executable-missing'
import {
  acceptProviderRootExit,
  closeProviderProcess,
  rootOnlyProviderClosePolicy,
  type ProviderProcessClosePolicy,
  type ProviderProcessCloseResult,
  type ProviderProcessTree
} from './provider-process-close'

const STDERR_TAIL_MAX_CHARS = 8192

export type ProviderProcessExit = {
  code: number | null
  signal: NodeJS.Signals | null
  processless: boolean
}

type ManagedProviderProcessOptions = {
  site: string
  /** Defaults to the root-only policy; only a provider with its own reaper overrides it. */
  policy?: ProviderProcessClosePolicy
  spawnImpl?: PipedProcessSpawner
  platform?: NodeJS.Platform
  inheritedEnv?: NodeJS.ProcessEnv
  /** Defaults to "the root is gone". */
  acceptClose?: (result: ProviderProcessCloseResult) => boolean
  /** Defaults to `session`; a one-shot's stdin end completes its request instead of stopping it. */
  lifetime?: ProviderProcessLifetime
  /** Any stdout or stderr chunk: the child is doing something. */
  onOutput?: () => void
}

export type ManagedProviderProcess = {
  child: PipedChildProcess
  /** POSIX: the child leads its own process group, which stops with Orca however Orca exits. */
  supervised: boolean
  /** The spawn failed before a process existed: absence is proven, but no exit was observed. */
  readonly processless: boolean
  /** `exited` covers a processless child too; use `rootExitObserved` for "a real process exited". */
  readonly rootVerdict: DescendantTreeVerdict
  /** A process that existed was seen to exit and its exit reported; never true for a processless child. */
  readonly rootExitObserved: boolean
  /** The root's own exit status, known before its group is reaped and its exit reported. */
  readonly rootExit: ProviderProcessExit | null
  /** The last close that ran the ladder; the already-exited answer only when none did. */
  readonly lastCloseResult: ProviderProcessCloseResult | null
  readonly exitPromise: Promise<void>
  /** The provider's own executable was not found: the spawn's ENOENT. */
  readonly executableMissing: boolean
  /** The last 8 KiB of stderr, which the managed process drains so the child never blocks on it. */
  stderrTail(): string
  onExit(listener: (exit: ProviderProcessExit) => void): void
  terminateTree(): Promise<ProviderProcessTeardownVerdict>
  /** `closeRequest` overrides the policy's for this close, as a wedged child's SIGTERM at once. */
  close(
    tree?: ProviderProcessTree,
    closeRequest?: ProviderCloseRequest
  ): Promise<ProviderProcessCloseResult>
}

/** One child owns its exit observation and every retry of an unconfirmed close. */
export function spawnManagedProviderProcess(
  launch: ProviderProcessLaunch,
  options: ManagedProviderProcessOptions
): ManagedProviderProcess {
  const platform = options.platform ?? process.platform
  const policy = options.policy ?? rootOnlyProviderClosePolicy
  const spec = createProviderSpawnSpec(launch, options.inheritedEnv ?? process.env, platform, {
    // A gone owner gets the close this provider's own close makes.
    closeRequest: policy.closeRequest ?? 'stdin-end',
    ...(options.lifetime ? { lifetime: options.lifetime } : {})
  })
  const child = (options.spawnImpl ?? spawnProcess)({
    program: spec.program,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    detached: spec.detached,
    stdio: ['pipe', 'pipe', 'pipe', ...spec.extraStdio]
  })
  const group = spec.adopt(child)
  const listeners = new Set<(exit: ProviderProcessExit) => void>()
  let observed: ProviderProcessExit | null = null
  // The root's own exit, which can precede `observed` while the rest of its group is reaped.
  let rootExit: ProviderProcessExit | null = null
  let spawnFailed = false
  let spawnError: unknown = null
  let lastCloseResult: ProviderProcessCloseResult | null = null
  const exitProof = new RetryableProcessExitProof(options.acceptClose ?? acceptProviderRootExit)
  let stderrTail = ''
  // An undrained stderr pipe blocks the child once it fills.
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS)
    options.onOutput?.()
  })
  if (options.onOutput) {
    observeReaderOutput(child.stdout, options.onOutput)
  }
  let resolveExit = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const observeExit = (exit: ProviderProcessExit): void => {
    if (observed) {
      return
    }
    observed = exit
    resolveExit()
    for (const listener of listeners) {
      listener(exit)
    }
    listeners.clear()
  }
  child.on('exit', (code, signal) => {
    const exit = { code, signal, processless: false }
    rootExit = exit
    // A group-led provider's exit is reported once its group is gone, never before a member.
    if (group) {
      void group.exited.then((reaped) => {
        lastCloseResult ??= { root: 'exited', tree: reaped ? 'exited' : 'unverifiable' }
        observeExit(exit)
      })
    } else {
      observeExit(exit)
    }
  })
  child.on('error', (error) => {
    spawnFailed ||= child.pid === undefined
    spawnError ??= error
  })
  child.on('close', (code, signal) => {
    const processless = spawnFailed && child.pid === undefined
    if (processless) {
      observeExit({ code, signal, processless })
    }
  })
  const rootVerdict = (): DescendantTreeVerdict =>
    observed || rootExit ? 'exited' : child.pid === undefined ? 'unverifiable' : 'live'
  const terminateTree = (): Promise<ProviderProcessTeardownVerdict> =>
    terminateProviderProcessTree(child, { site: options.site, platform })

  return {
    child,
    supervised: spec.supervised,
    exitPromise,
    get processless() {
      return observed?.processless ?? false
    },
    get rootVerdict() {
      return rootVerdict()
    },
    get rootExitObserved() {
      return observed !== null && !observed.processless
    },
    get rootExit() {
      return rootExit ?? observed
    },
    get executableMissing() {
      return isMissingProviderExecutable(spawnError, launch.command)
    },
    stderrTail: () => stderrTail,
    get lastCloseResult() {
      return lastCloseResult
    },
    onExit(listener) {
      if (observed) {
        listener(observed)
      } else {
        listeners.add(listener)
      }
    },
    terminateTree,
    close(tree, closeRequest) {
      return exitProof.run(async () => {
        // The one already-exited guard. It observed nothing, so an earlier close's findings stay.
        if (observed && !tree) {
          const result: ProviderProcessCloseResult = {
            ...lastCloseResult,
            root: 'exited',
            tree: lastCloseResult?.tree ?? null
          }
          lastCloseResult ??= result
          return result
        }
        const result = await closeProviderProcess({
          child,
          exitPromise,
          rootVerdict,
          group,
          policy: closeRequest ? { ...policy, closeRequest } : policy,
          tree,
          terminateTree
        })
        lastCloseResult = result
        return result
      })
    }
  }
}

/** Watches stdout only once its reader subscribes: a listener of our own would start the stream
 *  flowing and drop whatever arrived before a reader that subscribes late. */
function observeReaderOutput(
  stdout: Pick<NodeJS.ReadableStream, 'on' | 'removeListener'>,
  onOutput: () => void
): void {
  const onSubscribe = (event: string | symbol): void => {
    if (event !== 'data' && event !== 'readable') {
      return
    }
    stdout.removeListener('newListener', onSubscribe)
    // After the reader's own listener lands; no chunk can arrive before a microtask runs.
    queueMicrotask(() => stdout.on('data', onOutput))
  }
  stdout.on('newListener', onSubscribe)
}
