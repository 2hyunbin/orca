import { ProviderExternalTree } from './provider-external-tree'
import type { PipedChildProcess, PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { RetryableProcessExitProof } from '@orca/process-host/retryable-process-exit-proof'
import type { ProviderProcessLaunch } from './provider-process-launch'
import { createProviderSpawnSpec } from './provider-process-launch'
import { PROVIDER_GROUP_REAP_TIMEOUT_MS } from './provider-process-timing'
import { recordProviderLaunch, verifyProviderWriters } from './provider-process-ledger'
import {
  observeProviderGroup,
  signalProviderGroup,
  stopRecordedProviderGroup
} from './provider-process-group'
import { waitForProcessExitUntil } from './provider-process-exit-deadline'
import {
  terminateProviderProcessTree,
  type ProviderProcessTeardownVerdict
} from './provider-process-teardown'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { isMissingProviderExecutable } from './provider-executable-missing'
import {
  closeProviderProcess,
  rootOnlyProviderClosePolicy,
  type ProviderProcessClosePolicy,
  type ProviderProcessCloseResult,
  type ProviderProcessTree
} from './provider-process-close'

import { observeProviderOutput, type ProviderProcessOutputOptions } from './provider-process-output'

export type ProviderProcessExit = {
  code: number | null
  signal: NodeJS.Signals | null
  processless: boolean
}

type ManagedProviderProcessOptions = ProviderProcessOutputOptions & {
  site: string
  /** Defaults to the root-only policy; only a provider with its own reaper overrides it. */
  policy?: (dedicatedGroup: boolean) => ProviderProcessClosePolicy
  spawnImpl?: PipedProcessSpawner
  platform?: NodeJS.Platform
  inheritedEnv?: NodeJS.ProcessEnv
  /** Defaults to "the root is gone". */
  acceptClose?: (result: ProviderProcessCloseResult) => boolean
}

export type ManagedProviderProcess = {
  child: PipedChildProcess
  dedicatedGroup: boolean
  /** The spawn failed before a process existed: absence is proven, but no exit was observed. */
  readonly processless: boolean
  /** `exited` covers a processless child too; use `rootExitObserved` for "a real process exited". */
  readonly rootVerdict: DescendantTreeVerdict
  /** A process that existed was seen to exit; never true for a processless child. */
  readonly rootExitObserved: boolean
  /** The last close that ran the ladder; the already-exited answer only when none did. */
  readonly lastCloseResult: ProviderProcessCloseResult | null
  readonly exitPromise: Promise<void>
  readonly completion: Promise<ProviderProcessExit>
  readonly settled: boolean
  onSettled(listener: (exit: ProviderProcessExit) => void): void
  verifyWriters(): Promise<boolean>
  /** The configured executable was missing at spawn. */
  readonly executableMissing: boolean
  /** The last 8 KiB of stderr, which the managed process drains so the child never blocks on it. */
  stderrTail(): string
  onExit(listener: (exit: ProviderProcessExit) => void): void
  terminateTree(): Promise<ProviderProcessTeardownVerdict>
  attachTree(tree: ProviderProcessTree): void
  close(tree?: ProviderProcessTree): Promise<ProviderProcessCloseResult>
}

/** One child owns its exit observation and every retry of an unconfirmed close. */
export function spawnManagedProviderProcess(
  launch: ProviderProcessLaunch,
  options: ManagedProviderProcessOptions
): ManagedProviderProcess {
  const platform = options.platform ?? process.platform
  const closePolicy = options.policy ?? rootOnlyProviderClosePolicy
  const spec = createProviderSpawnSpec(launch, options.inheritedEnv ?? process.env, platform)
  const policy = closePolicy(platform !== 'win32')
  const child = (options.spawnImpl ?? spawnProcess)({ ...spec, stdio: ['pipe', 'pipe', 'pipe'] })
  let groupRetired = false
  const group =
    platform !== 'win32' && child.pid !== undefined ? recordProviderLaunch(child.pid) : undefined
  const listeners = new Set<(exit: ProviderProcessExit) => void>()
  let observed: ProviderProcessExit | null = null
  let spawnFailed = false
  let spawnError: unknown = null
  let lastCloseResult: ProviderProcessCloseResult | null = null
  const output = observeProviderOutput(child, options, () => {
    void group?.capture()
  })
  const drain = output.drain
  let resolveExit = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const windowsExitProof = new RetryableProcessExitProof(
    options.acceptClose ?? ((result) => result.root === 'exited')
  )
  let groupFlight: Promise<ProviderProcessCloseResult> | undefined
  const external = new ProviderExternalTree()
  let naturalCleanup: Promise<DescendantTreeVerdict> | undefined
  let settled = false
  let resolveCompletion = (_exit: ProviderProcessExit): void => {}
  const completion = new Promise<ProviderProcessExit>((resolve) => {
    resolveCompletion = resolve
  })
  const reapExternal = (): Promise<DescendantTreeVerdict | null> => external.reap()
  const close = (tree?: ProviderProcessTree): Promise<ProviderProcessCloseResult> => {
    if (tree) {
      external.current = tree
    }
    if (platform === 'win32' && observed && !tree) {
      const result: ProviderProcessCloseResult = { root: 'exited', tree: null }
      lastCloseResult ??= result
      return Promise.resolve(lastCloseResult.root === 'exited' ? lastCloseResult : result)
    }
    if (platform === 'win32') {
      return windowsExitProof.run(async () => {
        lastCloseResult = await closeProviderProcess({
          child,
          exitPromise,
          rootVerdict,
          policy,
          tree: external.current,
          terminateTree
        })
        return lastCloseResult
      })
    }
    groupFlight ??= (async () => {
      if (!observed) {
        if (policy.immediateTerm && child.pid) {
          signalProviderGroup(child.pid, 'SIGTERM')
        }
        void group?.capture()
        await external.current?.capture()
        try {
          child.stdin.end()
        } catch {
          /* A broken pipe still owes cleanup. */
        }
        if (!policy.immediateTerm) {
          await waitForProcessExitUntil(exitPromise, policy.gracefulExitMs)
        }
        if (!observed) {
          void group?.capture()
        }
      }
      let verdict: DescendantTreeVerdict = 'exited'
      const pid = child.pid
      if (pid !== undefined && !observed?.processless) {
        verdict = observed
          ? await (naturalCleanup ??
              observeProviderGroup(child.pid, PROVIDER_GROUP_REAP_TIMEOUT_MS))
          : await (async () => {
              if (!policy.immediateTerm) {
                signalProviderGroup(pid, 'SIGTERM')
              }
              return stopRecordedProviderGroup(pid, group?.members() ?? [], undefined, true)
            })()
      }
      await waitForProcessExitUntil(exitPromise, PROVIDER_GROUP_REAP_TIMEOUT_MS)
      if (verdict === 'exited') {
        groupRetired = true
        void group?.retire()
      }
      return { root: rootVerdict(), tree: verdict }
    })()
    return (async () => {
      const previous = await groupFlight
      const natural = observed ? await naturalCleanup : undefined
      const result = natural === undefined ? previous : { ...previous, tree: natural }
      if (natural === 'exited' && !groupRetired) {
        groupRetired = true
        void group?.retire()
      }
      if (observed) {
        await drain()
      }
      const external = platform === 'win32' ? null : await reapExternal()
      lastCloseResult =
        external === null
          ? { ...result, root: rootVerdict() }
          : {
              ...result,
              root: rootVerdict(),
              tree:
                result.tree === 'exited'
                  ? external
                  : external === 'exited'
                    ? result.tree
                    : result.tree === 'live' || external === 'live'
                      ? 'live'
                      : 'unverifiable'
            }
      return lastCloseResult
    })()
  }
  const observeExit = (exit: ProviderProcessExit): void => {
    if (observed) {
      return
    }
    observed = exit
    if (platform !== 'win32' && child.pid !== undefined && !exit.processless && !groupRetired) {
      // Immediate root-exit cleanup is part of this launch, never replayed by a later close.
      signalProviderGroup(child.pid, 'SIGKILL')
      naturalCleanup = observeProviderGroup(child.pid, PROVIDER_GROUP_REAP_TIMEOUT_MS)
    }
    resolveExit()
    for (const listener of listeners) {
      listener(exit)
    }
    listeners.clear()
    void drain()
    void (async () => {
      try {
        await close()
        await drain()
        if (platform !== 'win32') {
          await reapExternal()
        }
      } catch {
        // Failed cleanup still settles the physical exit; writer proof stays separate.
      } finally {
        settled = true
        resolveCompletion(exit)
      }
    })()
  }
  child.on('exit', (code, signal) => observeExit({ code, signal, processless: false }))
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
    observed ? 'exited' : child.pid === undefined ? 'unverifiable' : 'live'
  const terminateTree = (): Promise<ProviderProcessTeardownVerdict> =>
    terminateProviderProcessTree(child, { site: options.site, platform })

  return {
    child,
    dedicatedGroup: platform !== 'win32',
    exitPromise,
    completion,
    get settled() {
      return settled
    },
    onSettled(listener) {
      void completion.then(listener)
    },
    async verifyWriters() {
      if (platform === 'win32') {
        return rootVerdict() === 'exited'
      }
      if (!child.pid) {
        return observed?.processless ?? false
      }
      const verified = await verifyProviderWriters(group, child.pid, groupRetired)
      if (verified) {
        groupRetired = true
        void group?.retire()
      }
      return verified
    },
    get processless() {
      return observed?.processless ?? false
    },
    get rootVerdict() {
      return rootVerdict()
    },
    get rootExitObserved() {
      return observed !== null && !observed.processless
    },
    get executableMissing() {
      return isMissingProviderExecutable(spawnError, launch.command)
    },
    stderrTail: output.stderrTail,
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
    attachTree(tree) {
      external.current = tree
      if (observed && platform !== 'win32') {
        void reapExternal().catch(() => {})
      }
    },
    close
  }
}
