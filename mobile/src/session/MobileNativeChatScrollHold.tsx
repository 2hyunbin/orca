import { Component, type RefObject } from 'react'
import { Platform } from 'react-native'

type Box = { top: number; bottom: number }

/** The parts of a DOM element this reads; on the page the list's scrollable node is one. */
type RowElement = {
  isConnected: boolean
  getBoundingClientRect: () => Box
  children: ArrayLike<RowElement>
}
type Scroller = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  getBoundingClientRect: () => Box
  firstElementChild: RowElement | null
}

type Held = { row: RowElement; top: number }

type Props = {
  /** The first row's key: a change in it is rows changing above the reader. */
  headKey: string | undefined
  /** The list has a header block: the "Load earlier" control, then the history loaded above. */
  header: boolean
  /** The header leads with the "Load earlier" control, which stays put as history lands below. */
  loadEarlier: boolean
  /** A footer cell (live status, waiting messages) ends the list; output above it moves it. */
  footer: boolean
  listRef: RefObject<{ getScrollableNode: () => Scroller | null | undefined } | null>
}

/** The message rows in drawing order, read with the props that drew them. */
function messageRows(content: RowElement, { header, loadEarlier, footer }: Props): RowElement[] {
  const cells = Array.from(content.children)
  const headerRows = header ? Array.from(cells.shift()?.children ?? []) : []
  if (footer) {
    cells.pop()
  }
  return [...headerRows.slice(loadEarlier ? 1 : 0), ...cells]
}

/** The message rows on screen, first one first. All of them: a head trim can remove the first. */
function rowsOnScreen(scroller: Scroller, props: Props): Held[] {
  const content = scroller.firstElementChild
  if (!content) {
    return []
  }
  const view = scroller.getBoundingClientRect()
  const rows = messageRows(content, props)
  // Rows in normal flow have ordered bottoms, so the first one on screen is found without
  // measuring the up to 2,000 above it.
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (rows[middle].getBoundingClientRect().bottom <= view.top) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  const held: Held[] = []
  for (let index = low; index < rows.length; index += 1) {
    const box = rows[index].getBoundingClientRect()
    if (box.top >= view.bottom) {
      break
    }
    held.push({ row: rows[index], top: box.top })
  }
  return held
}

/** iOS is still bouncing the list past an end. A write then lands while WebKit owns the scroll, and
 *  the list stops taking the reader's scrolls until they leave the chat. */
function overscrolled({ scrollTop, scrollHeight, clientHeight }: Scroller): boolean {
  return scrollTop < 0 || scrollTop > scrollHeight - clientHeight + 1
}

/** Keeps the page's view on the same rows when rows above it change, by putting the first message
 *  that was on screen back where it was. A class because only `getSnapshotBeforeUpdate` sees that
 *  row before the new ones are in the document. A native list holds its own place
 *  (`maintainVisibleContentPosition`). */
export class MobileNativeChatScrollHold extends Component<Props> {
  getSnapshotBeforeUpdate(previous: Props): Held[] | null {
    if (Platform.OS !== 'web' || previous.headKey === this.props.headKey) {
      return null
    }
    const scroller = this.props.listRef.current?.getScrollableNode()
    // The document still has the previous layout, so the previous props describe it.
    return scroller && !overscrolled(scroller) ? rowsOnScreen(scroller, previous) : null
  }

  componentDidUpdate(_previous: Props, _state: unknown, held: Held[] | null): void {
    const survivor = held?.find(({ row }) => row.isConnected)
    const scroller = survivor ? this.props.listRef.current?.getScrollableNode() : null
    if (survivor && scroller) {
      scroller.scrollTop += survivor.row.getBoundingClientRect().top - survivor.top
    }
  }

  render(): null {
    return null
  }
}
