import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { expectPaneToClose, type PaneCloseKind } from '@/runtime/layout-owner-pane-intents'

/**
 * A pane close in a layout-owner build: main closes the pane first, and the window removes it when
 * main's frame drops it (the frame reconciler runs the close `kind` names). False when a paired
 * server owns the workspace; the caller closes as today.
 */
export function sendPaneCloseToLayoutOwner(
  pane: { worktreeId: string; tabId: string; leafId: string; kind: PaneCloseKind },
  on: {
    /** Main cannot close it: close as today. */
    asToday: () => void
    /** Main refused the pane as its last. */
    lastPane: () => void
  }
): boolean {
  const { tabId, leafId } = pane
  const forget = expectPaneToClose(tabId, leafId, pane.kind)
  const sent = sendLayoutCommandToOwner(
    pane.worktreeId,
    { type: 'closePane', tabId, leafId, ...(pane.kind === 'exit' && { automatic: true }) },
    {
      apply: () => {},
      asToday: () => {
        forget()
        on.asToday()
      },
      refused: (code) => {
        forget()
        if (code === 'last_pane') {
          on.lastPane()
        }
      }
    }
  )
  if (!sent) {
    forget()
  }
  return sent
}
