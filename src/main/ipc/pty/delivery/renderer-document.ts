/**
 * The one lifetime fence for renderer claims: each page load mints a document
 * id in its preload, and every claim message carries it. A message from a new
 * document retires the old one whatever the event order; a retired document's
 * stragglers are ignored. In memory only, never persisted or sent to a host.
 */
const RETIRED_DOCUMENT_LIMIT = 16

let current: string | null = null
let navigatingFrom: string | null = null
const retired: string[] = []
// Why null-init + wrapper fn: see debug.ts — rolldown const-folds `export let fn = noop` bridges (STA-5661).
let retireImpl: ((doc: string) => void) | null = null

export function setRendererDocumentRetireHandler(fn: ((doc: string) => void) | null): void {
  retireImpl = fn
}

/** Whether a claim message from this document may act; a new document's first message switches. */
export function admitRendererDocument(doc: unknown): doc is string {
  if (typeof doc !== 'string' || !doc || retired.includes(doc)) {
    return false
  }
  if (current !== null && current !== doc) {
    retireCurrentRendererDocument()
  }
  current = doc
  return true
}

/** Until commit the old page is still live, and a cancelled navigation keeps it. */
export function noteRendererNavigationStart(): void {
  navigatingFrom = current
}

export function noteRendererNavigationCommit(): void {
  if (current !== null && current === navigatingFrom) {
    retireCurrentRendererDocument()
  }
  navigatingFrom = null
}

export function retireCurrentRendererDocument(): void {
  const doc = current
  navigatingFrom = null
  if (doc === null) {
    return
  }
  current = null
  retired.push(doc)
  if (retired.length > RETIRED_DOCUMENT_LIMIT) {
    retired.shift()
  }
  retireImpl?.(doc)
}

export function _resetRendererDocumentForTest(): void {
  current = null
  navigatingFrom = null
  retired.length = 0
}
