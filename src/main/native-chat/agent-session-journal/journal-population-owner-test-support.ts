import type { AgentSessionJournal } from './journal-store'
import type { JournalReducerState } from './journal-reducer'
import { JournalSelection } from './journal-selection'
import { JournalRowWriter } from './journal-row-writer'

export function populationState(journal: AgentSessionJournal): JournalReducerState {
  const owner: unknown = journal
  const state =
    typeof owner === 'object' && owner !== null && 'state' in owner ? owner.state : undefined
  if (!isPopulationState(state)) {
    throw new Error('real journal state is unavailable')
  }
  return state
}

function isPopulationState(value: unknown): value is JournalReducerState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'selection' in value &&
    value.selection instanceof JournalSelection &&
    'epoch' in value &&
    typeof value.epoch === 'string'
  )
}

export function populationWriter(journal: AgentSessionJournal): JournalRowWriter {
  const owner: unknown = journal
  const writer =
    typeof owner === 'object' && owner !== null && 'rowWriter' in owner
      ? owner.rowWriter
      : undefined
  if (!(writer instanceof JournalRowWriter)) {
    throw new Error('real journal writer is unavailable')
  }
  return writer
}
