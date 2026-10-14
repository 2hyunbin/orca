// @vitest-environment happy-dom
/**
 * The page's list keeps a search field focused through a scroll. react-native-web dismisses
 * `on-drag` on every scroll event, not only a drag, and narrowing search results clamps the
 * list's offset, which fires one: each keystroke closed the keyboard.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error TS7016: react-native-web ships no type declarations.
import ScrollView from 'react-native-web/dist/exports/ScrollView'
// @ts-expect-error TS7016: react-native-web ships no type declarations.
import TextInput from 'react-native-web/dist/exports/TextInput'
import { SCROLL_KEYBOARD_DISMISS_MODE } from './scroll-keyboard-dismiss-mode.web'
import { SCROLL_KEYBOARD_DISMISS_MODE as NATIVE_MODE } from './scroll-keyboard-dismiss-mode'

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

/** Whether the focused search field is still focused after the list scrolls once. */
function searchStaysFocusedThroughScroll(keyboardDismissMode: string): boolean {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      createElement(
        'div',
        null,
        createElement(TextInput, { testID: 'search' }),
        createElement(ScrollView, { testID: 'list', keyboardDismissMode })
      )
    )
  })
  const search = container.querySelector<HTMLInputElement>('[data-testid="search"]')!
  const list = container.querySelector<HTMLElement>('[data-testid="list"]')!
  act(() => search.focus())
  expect(document.activeElement).toBe(search)
  act(() => {
    list.dispatchEvent(new Event('scroll'))
  })
  return document.activeElement === search
}

describe('SCROLL_KEYBOARD_DISMISS_MODE', () => {
  it('keeps the page search field focused when the list scrolls', () => {
    expect(SCROLL_KEYBOARD_DISMISS_MODE).toBe('none')
    expect(searchStaysFocusedThroughScroll(SCROLL_KEYBOARD_DISMISS_MODE)).toBe(true)
  })

  it('stays on-drag natively, which on the page would blur on any scroll', () => {
    expect(NATIVE_MODE).toBe('on-drag')
    expect(searchStaysFocusedThroughScroll(NATIVE_MODE)).toBe(false)
  })
})
