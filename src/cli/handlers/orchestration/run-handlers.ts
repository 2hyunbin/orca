import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../shared/orchestration-run-pagination'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/orca-session-address-prefix'
import { isStructuredWorkerHandle } from '../../../shared/structured-worker-handle'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

export const ORCHESTRATION_RUN_HANDLERS: Record<string, CommandHandler> = {
  'orchestration run-create': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runCreate', {
      objective: getRequiredStringFlag(flags, 'objective'),
      from
    })
    printResult(result, json, (r) => `Run ${r.run.id} created and bound: ${r.run.objective}`)
  },

  'orchestration run-use': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runUse', {
      id: getRequiredStringFlag(flags, 'id'),
      from,
      ...(flags.has('takeover-legacy') ? { takeoverLegacy: true } : {})
    })
    printResult(result, json, (r) => `Using Run ${r.run.id}: ${r.run.objective}`)
  },

  'orchestration run-current': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      run: { id: string; objective: string } | null
    }>('orchestration.runCurrent', { from })
    printResult(result, json, (r) =>
      r.run
        ? `${r.run.id} ${r.run.objective}`
        : `No Run is bound to this ${from === undefined ? 'session' : 'terminal'}.`
    )
  },

  'orchestration run-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      runs: { id: string; objective: string; legacy: number }[]
      nextCursor: string | null
    }>('orchestration.runList', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit') ?? ORCHESTRATION_RUN_PAGE_LIMIT,
      cursor: getOptionalStringFlag(flags, 'cursor')
    })
    printResult(result, json, (r) => {
      const rows =
        r.runs.length === 0
          ? 'No Runs found.'
          : r.runs
              .map(
                (run) => `${run.id}${run.legacy ? ' [legacy, inspect only]' : ''} ${run.objective}`
              )
              .join('\n')
      return r.nextCursor ? `${rows}\nMore Runs: --cursor ${r.nextCursor}` : rows
    })
  },

  'orchestration run-show': async ({ flags, client, json }) => {
    const result = await client.call<{
      run: {
        id: string
        objective: string
        consumer_generation: number
        legacy: number
        created_at: string
      }
      // Absent from a runtime that predates it, and for a Run that never takes one (legacy, unbound).
      coordinator?: RunCoordinatorLine | null
    }>('orchestration.runShow', { id: getRequiredStringFlag(flags, 'id') })
    printResult(result, json, (r) => {
      const coordinator =
        r.coordinator === undefined ? '' : `\n${formatRunCoordinatorLine(r.coordinator)}`
      return (
        `${r.run.id}${r.run.legacy ? ' [legacy, inspect only]' : ''} ${r.run.objective}\n` +
        `consumer generation ${r.run.consumer_generation}; created ${r.run.created_at}${coordinator}`
      )
    })
  }
}

type RunCoordinatorLine = { address?: string; status: string; reason?: string }

const MAIL_WAITS =
  'mail waits unread in the Run mailbox; tell the user rather than picking another recipient'

function formatRunCoordinatorLine(coordinator: RunCoordinatorLine | null): string {
  if (!coordinator) {
    return `coordinator: none bound; ${MAIL_WAITS}`
  }
  const reason = coordinator.reason ? ` (${coordinator.reason})` : ''
  const state =
    coordinator.status === 'live'
      ? `live; mail reaches it${startedByMail(coordinator.address) ? ', and starts it if it is at rest' : ''}`
      : coordinator.status === 'exited'
        ? `exited${reason}; ${MAIL_WAITS}`
        : `${coordinator.status}${reason}`
  return `coordinator: ${coordinator.address ? `${coordinator.address}, ` : ''}${state}`
}

/** Only a session (chat or structured worker) is promised a start: a live terminal is typed into
 *  only while an agent sits at its prompt, and a shell whose agent exited starts nothing. */
function startedByMail(address: string | undefined): boolean {
  return (
    isStructuredWorkerHandle(address) || Boolean(address?.startsWith(ORCA_SESSION_ADDRESS_PREFIX))
  )
}
