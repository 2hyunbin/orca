// A paste saving as a file, from the pill put where it went to the result that replaces the pill in
// its own scope's draft, and the Send hold while it saves.
import { Fragment, Slice } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { nativeChatImageSendBlock } from './native-chat-image-reattach'
import { fileReferenceContent, promptText, promptTextContent } from './native-chat-prompt-document'
import {
  NATIVE_CHAT_PASTED_TEXT_TOKEN,
  nativeChatPastedTextOperations as operations,
  nativeChatPastedTextId,
  nativeChatPastedTextToken,
  replaceNativeChatPastedTextNodes
} from './native-chat-pasted-text-reference'

/** `saving`: a paste in the scope's draft is on its way; `unsaved`: a restart lost one. */
export function nativeChatPastedTextAdmission(scopeKey: string): 'saving' | 'unsaved' | null {
  const tokens = readNativeChatComposerDraft(scopeKey).text.split(NATIVE_CHAT_PASTED_TEXT_TOKEN)
  const ids = tokens.filter((_, index) => index % 2 === 1).map(nativeChatPastedTextId)
  if (ids.some((id) => id !== null && operations.get(id)?.scopeKey === scopeKey)) {
    return 'saving'
  }
  return ids.length > 0 ? 'unsaved' : null
}

/** Send waits for the composer's images and for any paste in its draft still saving. */
export function nativeChatComposerSendBlock(
  attachments: readonly NativeChatComposerImageAttachment[],
  scopeKey: string
): ReturnType<typeof nativeChatImageSendBlock> {
  const block = nativeChatImageSendBlock(attachments)
  const saving = nativeChatPastedTextAdmission(scopeKey) === 'saving'
  return { ...block, holdsSend: block.holdsSend || saving }
}

export function beginNativeChatPastedText(
  scopeKey: string,
  stage: NonNullable<NativeChatComposerInput['stagePastedText']>,
  text: string
): string {
  const id = createUuidV4()
  stage(nativeChatPastedTextToken(id), (replaced, schema) =>
    operations.set(id, { scopeKey, text, replaced, schema })
  )
  return id
}

export type NativeChatPastedTextOutcome = { path: string } | 'inline' | 'restore'

/** Replaces a paste's pill in its own scope's draft: in the editor while it shows that scope, else
 *  in the stored draft. A pill already gone stays gone; `onReplaced` runs only if one was there. */
export function settleNativeChatPastedText(
  id: string,
  scopeEditor: () => NativeChatComposerInput | null,
  outcome: NativeChatPastedTextOutcome,
  onReplaced: () => void
): void {
  const operation = operations.get(id)
  if (!operation) {
    return
  }
  const { schema, scopeKey } = operation
  const token = nativeChatPastedTextToken(id)
  const content =
    outcome === 'restore'
      ? operation.replaced
      : outcome === 'inline'
        ? new Slice(schema.nodeFromJSON(promptTextContent(operation.text)).content, 1, 1)
        : new Slice(Fragment.from(schema.nodeFromJSON(fileReferenceContent(outcome.path))), 0, 0)
  const editor = scopeEditor()
  const { text, document } = readNativeChatComposerDraft(scopeKey)
  let replaced = false
  if (editor?.replacePastedText) {
    const result = editor.replacePastedText(token, content)
    if (result === 'composing') {
      // An IME composition owns the field until it ends.
      const retry = (): void => settleNativeChatPastedText(id, scopeEditor, outcome, onReplaced)
      window.addEventListener('compositionend', () => setTimeout(retry), { once: true })
      return
    }
    replaced = result
  } else if (text.includes(token)) {
    const tr = new Transform(schema.nodeFromJSON(document ?? promptTextContent(text)))
    replaced = replaceNativeChatPastedTextNodes(tr, token, content)
    if (replaced) {
      const settled = { text: promptText(tr.doc), document: tr.doc.toJSON() }
      updateNativeChatComposerDraft(scopeKey, settled, 'immediate')
    }
  }
  operations.delete(id)
  if (replaced) {
    onReplaced()
  }
}
