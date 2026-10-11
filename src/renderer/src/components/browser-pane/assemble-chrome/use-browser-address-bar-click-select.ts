import { useCallback, useRef, type MouseEvent, type MutableRefObject } from 'react'

/**
 * Browser-style mouse selection for the address bar: the click that focuses it selects the whole
 * URL, a double-click selects a word, and a triple-click selects everything again.
 */
export function useBrowserAddressBarClickSelect(): {
  /** Set from the focusing left press until its click, so focus can skip its own select-all. */
  initialMouseDownRef: MutableRefObject<boolean>
  onMouseDown: (event: MouseEvent<HTMLInputElement>) => void
  onClick: (event: MouseEvent<HTMLInputElement>) => void
} {
  const initialMouseDownRef = useRef(false)
  const clickSelectedAllRef = useRef(false)

  const onMouseDown = useCallback((event: MouseEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const focusing = event.button === 0 && document.activeElement !== input
    initialMouseDownRef.current = focusing
    // Why: a press inside a selection is a possible text drag to Chromium, so it neither places
    // a caret (focus restores the blurred bar's old selection) nor picks a double-click word.
    // Clearing that selection first lets both behave like Firefox and Chrome.
    if (focusing) {
      // Focus first: a press that focuses the bar would restore the selection being cleared.
      input.focus()
      input.setSelectionRange(0, 0)
    } else if (event.detail > 1 && clickSelectedAllRef.current) {
      input.setSelectionRange(0, 0)
    }
    clickSelectedAllRef.current = false
  }, [])

  const onClick = useCallback((event: MouseEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    // Preserve native drag selection; only expand a collapsed initial click.
    if (initialMouseDownRef.current && input.selectionStart === input.selectionEnd) {
      input.select()
      clickSelectedAllRef.current = true
    }
    initialMouseDownRef.current = false
  }, [])

  return { initialMouseDownRef, onMouseDown, onClick }
}
