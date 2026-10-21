import { setTimeout as delay } from 'node:timers/promises'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { ProviderExecControl } from './provider-exec-control'
import type { ProviderProcessTree } from './provider-process-close'
import { waitForProcessExitUntil } from './provider-process-exit-deadline'
import {
  PROVIDER_GROUP_REAP_TIMEOUT_MS,
  PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS,
  PROVIDER_SIGTERM_GRACE_MS,
  PROVIDER_STDIN_END_GRACE_MS
} from './provider-process-supervisor'

export type ProviderExecSettlement = {
  root: DescendantTreeVerdict
  group: DescendantTreeVerdict
  tree: DescendantTreeVerdict | null
  output: 'complete' | 'incomplete'
  terminal: 'retired' | 'abandoned' | 'lost'
}
type SettlementOptions = {
  reason: 'close' | 'natural'
  tree?: ProviderProcessTree
}
const settlements = new WeakMap<ProviderExecControl, Promise<ProviderExecSettlement>>()

/** Unused owner ladder: signals retain session authority; physical exit never substitutes for it. */
export function settleProviderExec(control: ProviderExecControl, options: SettlementOptions) {
  const existing = settlements.get(control)
  if (existing) {
    return existing
  }
  const pending = settle(control, options)
  settlements.set(control, pending)
  return pending
}

async function settle(
  control: ProviderExecControl,
  options: SettlementOptions
): Promise<ProviderExecSettlement> {
  let group: DescendantTreeVerdict = 'unverifiable'
  let tree: DescendantTreeVerdict | null = options.tree ? 'unverifiable' : null
  let terminal: ProviderExecSettlement['terminal'] = 'lost'
  const phase = async (step: 0 | 1 | 2, duration: number): Promise<void> => {
    let observation = await control.operation('PROBE')
    const deadline = observation.monotonicMs + duration
    if (observation.group === 'live') {
      // The crash backstop must accept the remaining deadline before normal actuation.
      await control.acceptPhase(step, deadline)
      if (step !== 0) {
        observation = await control.operation(step === 1 ? 'TERM' : 'KILL')
      }
      while (observation.group === 'live' && observation.monotonicMs < deadline) {
        if (
          control.rootVerdict === 'exited' &&
          (step === 0 || (step === 1 && control.lifetime === 'one-shot'))
        ) {
          break
        }
        await delay(25)
        observation = await control.operation('PROBE')
      }
    }
    group = observation.group
  }
  try {
    await options.tree?.capture()
  } catch {
    // A failed snapshot cannot prevent stopping the dedicated group.
  }
  try {
    control.child.stdin.end()
  } catch {
    // A broken request pipe still owes group settlement.
  }
  try {
    group = (await control.operation('PROBE')).group
    if (
      group === 'live' &&
      options.reason === 'close' &&
      control.rootVerdict !== 'exited' &&
      control.closeRequest === 'stdin-end'
    ) {
      await phase(0, PROVIDER_STDIN_END_GRACE_MS)
    }
    if (group === 'live' && control.rootVerdict !== 'exited' && options.reason === 'close') {
      await phase(1, PROVIDER_SIGTERM_GRACE_MS)
    }
    if (group === 'live') {
      await phase(2, PROVIDER_GROUP_REAP_TIMEOUT_MS)
    }
  } catch {
    group = 'unverifiable'
  }
  try {
    await options.tree?.refresh?.()
    tree = (await options.tree?.reap()) ?? null
  } catch {
    tree = 'unverifiable'
  }
  try {
    const retired = group === 'exited' && (tree === null || tree === 'exited')
    await control.finish(retired ? 'RETIRE' : 'ABANDON')
    terminal = retired ? 'retired' : 'abandoned'
  } catch {
    control.disconnect()
  }
  const streams = [control.child.stdout, control.child.stderr]
  const ended = Promise.withResolvers<void>()
  const check = (): void => {
    if (streams.every((stream) => stream.readableEnded || stream.destroyed)) {
      ended.resolve()
    }
  }
  for (const stream of streams) {
    stream.on('end', check).on('close', check)
  }
  check()
  await waitForProcessExitUntil(ended.promise, PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS)
  const output = streams.every((stream) => stream.readableEnded) ? 'complete' : 'incomplete'
  for (const stream of streams) {
    stream.removeListener('end', check).removeListener('close', check)
    stream.destroy()
  }
  return { root: control.rootVerdict, group, tree, output, terminal }
}
