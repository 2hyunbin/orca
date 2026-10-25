import { useCallback, useRef, useState } from 'react'

type WorktreeCardDetailMenu = 'issue' | 'review' | 'link-actions'

export function useWorktreeCardDetailsHoverControl() {
  const [open, setOpen] = useState(false)
  const [openMenu, setOpenMenu] = useState<WorktreeCardDetailMenu | null>(null)
  const pendingHoverCloseRef = useRef(false)

  const closeHover = useCallback(() => {
    pendingHoverCloseRef.current = false
    setOpenMenu(null)
    setOpen(false)
  }, [])

  const handleHoverOpenChange = useCallback(
    (next: boolean) => {
      // Why: portaled detail menus sit outside HoverCardContent — keep the card
      // mounted until the menu closes so the menu items stay clickable.
      if (openMenu) {
        pendingHoverCloseRef.current = !next
        return
      }
      // Why: a link opened in the system browser takes focus (and the pointer)
      // away; keep the card so it is still there when the user comes back.
      if (!next && !document.hasFocus()) {
        return
      }
      pendingHoverCloseRef.current = false
      setOpen(next)
    },
    [openMenu]
  )

  const setDetailMenuOpen = useCallback((menu: WorktreeCardDetailMenu, next: boolean) => {
    setOpenMenu(next ? menu : null)
    if (!next && pendingHoverCloseRef.current) {
      pendingHoverCloseRef.current = false
      // Why: the link-action popover anchors on the card, so leaving the card
      // for the popover is not a request to dismiss it.
      if (menu !== 'link-actions') {
        setOpen(false)
      }
    }
  }, [])

  return {
    hoverOpen: open || Boolean(openMenu),
    issueMenuOpen: openMenu === 'issue',
    reviewMenuOpen: openMenu === 'review',
    handleHoverOpenChange,
    handleIssueMenuOpenChange: (next: boolean) => setDetailMenuOpen('issue', next),
    handleReviewMenuOpenChange: (next: boolean) => setDetailMenuOpen('review', next),
    handleLinkActionsOpenChange: (next: boolean) => setDetailMenuOpen('link-actions', next),
    closeHover
  }
}

export type WorktreeCardDetailsHoverControl = ReturnType<typeof useWorktreeCardDetailsHoverControl>
