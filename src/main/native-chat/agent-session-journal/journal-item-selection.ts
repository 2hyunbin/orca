import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalReducerState } from './journal-reducer'
import type { JournalSelection } from './journal-selection'

export function updateSelectedJournalItem(
  selection: JournalSelection,
  id: string,
  value: AgentJournalRenderItem | undefined,
  previous: AgentJournalRenderItem | undefined,
  state: JournalReducerState
): void {
  selection.order.update(
    'itemClears',
    id,
    value && isAgentSessionContextClear(value.body)
      ? { sequence: value.sequence, ordinal: 0 }
      : undefined
  )
  if ((value !== undefined) !== (previous !== undefined)) {
    selection.groups.update(
      'readyReports',
      id,
      value !== undefined && selection.groups.has(`report:${id}`)
    )
    selection.invalidate(`legacyReport:${id}`)
  }
  updateSelectedTypedTurn(selection, id, value, state)
  const signature = JSON.stringify(
    value && [
      value.revision,
      value.sequence,
      value.sequenceIndex,
      value.observedAt,
      value.turnScope
    ]
  )
  if (selection.storage.map<string, string>('itemSignatures').get(id) !== signature) {
    if (signature === undefined) {
      selection.storage.map<string, string>('itemSignatures').delete(id)
    } else {
      selection.storage.map<string, string>('itemSignatures').set(id, signature)
    }
    selection.groups.update('refreshEchoAddresses', id, true)
    if (!selection.deferred) {
      while (selection.refreshStep(state)) {
        // Complete source effects before the next body mutation.
      }
    }
  }
}

export function updateSelectedJournalAlias(
  selection: JournalSelection,
  alias: string,
  target: string | undefined,
  previous: string | undefined,
  state: JournalReducerState
): void {
  if (previous === target) {
    return
  }
  if (previous !== undefined) {
    selection.groups.update(`aliases:${previous}`, alias, false)
  }
  if (target !== undefined) {
    selection.groups.update(`aliases:${target}`, alias, true)
  }
  selection.groups.update('refreshAliases', alias, true)
  if (!selection.deferred) {
    while (selection.refreshStep(state)) {
      // Source-local alias changes use the same primitives on the live path.
    }
  }
}

export function updateSelectedTypedTurn(
  selection: JournalSelection,
  id: string,
  item: AgentJournalRenderItem | undefined,
  state: JournalReducerState,
  retarget = false
): void {
  const records = selection.storage.map<string, { user: string; source: string }>('turnSources')
  const old = records.get(id)
  const user = readAgentJournalTurn(item?.body)?.userItemId || undefined
  const source = user === undefined ? undefined : (state.aliases.get(user) ?? user)
  if (old?.source !== source) {
    if (old) {
      selection.groups.update(`turns:${old.source}`, id, false)
      if (retarget) {
        selection.groups.update('aliasRestDirty', old.source, true)
      }
    }
    if (source !== undefined) {
      selection.groups.update(`turns:${source}`, id, true)
      if (retarget) {
        selection.groups.update('aliasRestDirty', source, true)
      }
    }
  }
  if (old?.user !== user) {
    if (old) {
      selection.groups.update(`aliasUsers:${old.user}`, id, false)
    }
    if (user !== undefined) {
      selection.groups.update(`aliasUsers:${user}`, id, true)
    }
  }
  if (user === undefined || source === undefined) {
    records.delete(id)
  } else {
    records.set(id, { user, source })
  }
}
