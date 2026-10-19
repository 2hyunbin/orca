// A paste still saving as a file holds its place in the draft as this fixed token, so the file lands
// where the paste went however the draft changed meanwhile. It never reaches an agent.
import { translate } from '@/i18n/i18n'
import type { Schema, Slice } from '@tiptap/pm/model'
import type { Transform } from '@tiptap/pm/transform'

/** This renderer's pastes still saving, by id; `replaced` is the selection a refusal puts back.
 *  Never saved, so after a restart a pill has no entry and reads as unsaved. */
export const nativeChatPastedTextOperations = new Map<
  string,
  { scopeKey: string; text: string; replaced: Slice; schema: Schema }
>()

export function nativeChatPastedTextLabel(): string {
  return translate('components.native-chat.composer.pastedTextLabel', 'Pasted text')
}

export function nativeChatPasteNotSavedNotice(): string {
  return translate(
    'components.native-chat.composer.pasteNotSaved',
    'This paste was not saved. Paste it again or remove it.'
  )
}

/** Captures each token, so text split around them has the tokens at odd indices. */
export const NATIVE_CHAT_PASTED_TEXT_TOKEN = /(\[Pasted text\]\(orca-paste:[0-9a-f-]{36}\))/

export function nativeChatPastedTextToken(id: string): string {
  return `[Pasted text](orca-paste:${id})`
}

/** The paste a token names, or null for anything else. */
export function nativeChatPastedTextId(token: string): string | null {
  return /^\[Pasted text\]\(orca-paste:([0-9a-f-]{36})\)$/.exec(token)?.[1] ?? null
}

/** Swaps every pill carrying `token` for `content`, last first so earlier positions hold; false
 *  when none is left. */
export function replaceNativeChatPastedTextNodes(tr: Transform, token: string, content: Slice) {
  const positions: number[] = []
  tr.doc.descendants((node, position) => {
    if (node.attrs.token === token) {
      positions.push(position)
    }
  })
  positions.toReversed().forEach((position) => tr.replace(position, position + 1, content))
  return positions.length > 0
}
