import type { Schema, Slice } from '@tiptap/pm/model'

/** Text coordinates keep transport, attachments, and picker logic independent of the editor. */
export type NativeChatComposerInput = Pick<
  HTMLTextAreaElement,
  | 'value'
  | 'selectionStart'
  | 'selectionEnd'
  | 'disabled'
  | 'focus'
  | 'select'
  | 'setSelectionRange'
> & {
  contains?: (node: Node | null) => boolean
  insertText?: (text: string) => void
  insertSkill?: (from: number, to: number, token: string) => void
  /** Deletes every chip of one image, as when its thumbnail goes. */
  removeImageReferences?: (attachmentId: string) => void
  /** Inserts each file at the caret as a pill; its text stays the `@path` reference. */
  insertFileReferences?: (paths: string[]) => void
  /** Replaces the selection with a pasted text's pending pill, as one undo step of its own;
   *  `register` gets what it replaced before the pill renders. */
  stagePastedText?: (token: string, register: (replaced: Slice, schema: Schema) => void) => void
  /** Swaps every pill carrying `token` for `content`, outside undo history; false when none is
   *  left, `composing` while an IME composition owns the field. */
  replacePastedText?: (token: string, content: Slice) => boolean | 'composing'
  /** Whether a collapsed caret sits on the first (`start`) or last (`end`) visual line,
   *  counting wrapped lines, so an arrow key there has nowhere left to move it. */
  isCaretOnVisualEdge?: (edge: 'start' | 'end') => boolean
}

export function insertNativeChatPastedText(
  input: NativeChatComposerInput | null,
  text: string
): boolean {
  if (!input || input.disabled || !input.insertText) {
    return false
  }
  // A paste routed from a hidden terminal or a transcript click must leave the caret in the composer.
  input.focus()
  input.insertText(text)
  return true
}
