import {
  isAgentSessionContextHistory,
  latestAgentSessionContextClearSequence
} from '../../../../shared/agent-session-context-clear'
import type {
  StructuredAgentSessionState,
  StructuredAgentSessionAction
} from '../../../../shared/structured-agent-session-reducer'

export function structuredSessionSourceWasReplaced(
  prior: StructuredAgentSessionState,
  state: StructuredAgentSessionState,
  action: StructuredAgentSessionAction
): boolean {
  if (state === prior) {
    return false
  }
  if (
    state.epoch !== prior.epoch ||
    latestAgentSessionContextClearSequence(state.items) > (prior.cursor?.sequence ?? 0)
  ) {
    return true
  }
  const event = action.type === 'event' ? action.event : null
  if (event?.type === 'reset') {
    return true
  }
  const page =
    action.type === 'history-page' || action.type === 'older-page'
      ? action.page
      : event?.type === 'snapshot'
        ? event.page
        : null
  const removals =
    page?.removedItemIds ?? (event?.type === 'batch' ? event.batch.removedItemIds : [])
  if (
    removals.some((id) => {
      // A replacement snapshot can witness an earlier removal followed by recreation.
      if (event?.type === 'snapshot') {
        return true
      }
      const item = prior.items.find((item) => item.itemId === id)
      return !item || isAgentSessionContextHistory(item.body)
    })
  ) {
    return true
  }
  if (!page || action.type === 'older-page') {
    return false
  }
  const oldest = page.window.oldest?.sequence
  const newest = page.window.newest?.sequence
  if (oldest === undefined || newest === undefined) {
    return false
  }
  const ids = new Set(page.items.map((item) => item.itemId))
  const uncertain = new Set(
    page.items
      .filter(
        (item) => item.body.kind === 'status' && item.body.presentation === 'history-item-too-large'
      )
      .map((item) => item.sequence)
  )
  return prior.items.some(
    (item) =>
      isAgentSessionContextHistory(item.body) &&
      item.sequence >= oldest &&
      item.sequence <= newest &&
      !uncertain.has(item.sequence) &&
      !ids.has(item.itemId)
  )
}
