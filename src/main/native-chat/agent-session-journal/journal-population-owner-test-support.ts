import type { AgentSessionJournal } from './journal-store'
import type { JournalReducerState } from './journal-reducer'
import { JournalSelection } from './journal-selection'
import { JournalRowWriter } from './journal-row-writer'

export function populationState(journal: AgentSessionJournal): JournalReducerState {
  const state: unknown = Reflect.get(journal, 'state')
  if (!isPopulationState(state)) {
    throw new Error('real journal state is unavailable')
  }
  return state
}

function isPopulationState(value: unknown): value is JournalReducerState {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'selection') instanceof JournalSelection &&
    typeof Reflect.get(value, 'epoch') === 'string'
  )
}

export function populationWriter(journal: AgentSessionJournal): JournalRowWriter {
  const writer: unknown = Reflect.get(journal, 'rowWriter')
  if (!(writer instanceof JournalRowWriter)) {
    throw new Error('real journal writer is unavailable')
  }
  return writer
}
