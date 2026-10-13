import { createInterface } from 'node:readline'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { SELECTED_TRANSCRIPT_MAX_BYTES } from '../../shared/ai-vault-selected-session'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'

export type SelectedTranscriptRead = { signal?: AbortSignal }

/** Selected reads reuse provider folds, without reading a partial oversized source. */
export async function* selectedTranscriptLines(path: string, options: SelectedTranscriptRead) {
  throwIfSignalAborted(options.signal)
  const stream = openTranscriptReadStream(path, { encoding: 'utf-8' }, 'exact', options.signal)
  let bytes = 0
  const count = (chunk: string | Buffer): void => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > SELECTED_TRANSCRIPT_MAX_BYTES) {
      stream.destroy(new Error('Conversation history exceeds the import size limit.'))
    }
  }
  stream.on('data', count)
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let validRecords = 0
  try {
    for await (const line of lines) {
      throwIfSignalAborted(options.signal)
      try {
        const record: unknown = JSON.parse(line)
        if (record && typeof record === 'object' && !Array.isArray(record)) {
          validRecords++
        }
      } catch {
        /* The provider fold handles an incomplete final record. */
      }
      yield line
    }
    throwIfSignalAborted(options.signal)
    if (!validRecords) {
      throw new Error('Conversation history could not be read.')
    }
  } finally {
    lines.close()
    stream.off('data', count)
    stream.destroy()
  }
}
