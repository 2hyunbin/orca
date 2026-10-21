import type { TuiAgent } from './tui-agent'

/** A startup draft main was to paste into a window tab's agent that never landed. */
export type StartupDraftNotPastedEvent = { worktreeId: string; tabId: string; agent: TuiAgent }
