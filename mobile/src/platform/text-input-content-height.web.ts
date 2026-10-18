import { useLayoutEffect, useState, type RefObject } from 'react'
import type { TextInput } from 'react-native'

/** Web sibling: a textarea keeps whatever height it was given, so after each change collapse it,
 *  read its content's full height (padding and borders included) and render at that height. */
export function useTextInputContentHeight(
  input: RefObject<TextInput | null>,
  value: string
): number | undefined {
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    const node: unknown = input.current
    if (!(node instanceof HTMLTextAreaElement)) {
      return
    }
    const rendered = node.style.height
    node.style.height = '0px'
    // Collapsed, offsetHeight - clientHeight is just the borders; scrollHeight is content plus padding.
    const next = node.scrollHeight + node.offsetHeight - node.clientHeight
    node.style.height = rendered
    setHeight(next)
  }, [input, value])
  return height
}
