import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import type {
  AutomaticWorkMode,
  AutomaticWorkResumeResult
} from '../../shared/host-spawn-admission'

type AutomaticWorkResumeResponse = { automaticWork: AutomaticWorkResumeResult | null }

const PAUSE_REASONS: Record<Extract<AutomaticWorkMode, { kind: 'paused' }>['reason'], string> = {
  unclean_host_death: 'the terminal host stopped unexpectedly',
  pressure: 'the host was under heavy process load',
  operator: 'an operator paused them'
}

export function formatAutomaticWorkResume(result: AutomaticWorkResumeResponse): string {
  const automaticWork = result.automaticWork
  if (!automaticWork) {
    return 'This host has no automatic-restore gate to resume (its terminal host predates it).'
  }
  if (!automaticWork.cleared || automaticWork.cleared.kind !== 'paused') {
    return 'Automatic restores were not paused; nothing to resume.'
  }
  const since = new Date(automaticWork.cleared.since).toISOString()
  return `Automatic restores resumed. They were paused at ${since} because ${PAUSE_REASONS[automaticWork.cleared.reason]}.`
}

export const SERVE_RESTORE_HANDLERS: Record<string, CommandHandler> = {
  'serve restore resume': async ({ client, json }) => {
    const response = await client.call<AutomaticWorkResumeResponse>('runtime.automaticWork.resume')
    printResult(response, json, formatAutomaticWorkResume)
  }
}
