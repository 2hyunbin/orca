import onigurumaWasmUrl from 'vscode-oniguruma/release/onig.wasm?url'
import * as oniguruma from 'vscode-oniguruma'
import type { IOnigLib } from 'shiki/textmate'
import { textmateOnigurumaLibrary } from '../syntax-highlighting/textmate-core'
import type {
  PluginGrammarRequest,
  PluginGrammarResponse
} from '../../../../shared/plugins/plugin-grammar-protocol'
import { tokenizePluginGrammarDocument } from './plugin-grammar-tokenization'

let onigLib: Promise<IOnigLib> | undefined

function loadWorkerOniguruma(): Promise<IOnigLib> {
  onigLib ??= (async () => {
    const response = await fetch(onigurumaWasmUrl)
    if (!response.ok) {
      throw new Error('Grammar engine unavailable')
    }
    await oniguruma.loadWASM(response)
    return textmateOnigurumaLibrary(oniguruma)
  })()
  return onigLib
}

function send(response: PluginGrammarResponse, transfer: Transferable[] = []): void {
  globalThis.postMessage(response, { transfer })
}

globalThis.onmessage = async (event: MessageEvent<PluginGrammarRequest>): Promise<void> => {
  const request = event.data
  const identity = {
    id: request.id,
    generation: request.generation,
    version: request.version
  }
  try {
    const data = await tokenizePluginGrammarDocument(request, loadWorkerOniguruma(), () => {
      send({ type: 'progress', ...identity })
    })
    if (data) {
      send({ type: 'complete', ...identity, data }, [data.buffer])
    } else {
      send({ type: 'unavailable', ...identity })
    }
  } catch {
    // Diagnostics deliberately omit grammar strings and document contents.
    send({ type: 'unavailable', ...identity })
  }
}
