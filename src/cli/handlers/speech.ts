import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

type OpenAiSpeechKeyStatus = { configured: boolean; protection: string | null }

const MAX_KEY_BYTES = 4096

function formatKeyStatus(status: OpenAiSpeechKeyStatus): string {
  if (!status.configured) {
    return 'No OpenAI key for voice dictation on this host.'
  }
  return status.protection === 'plaintext'
    ? 'OpenAI key saved on this host, unencrypted: this host cannot seal secrets.'
    : 'OpenAI key saved on this host.'
}

// Why stdin and never a flag: argv shows up in shell history and process listings.
export async function readOpenAiKeyFromStdin(
  stdin: AsyncIterable<unknown> & { isTTY?: boolean } = process.stdin
): Promise<string> {
  if (stdin.isTTY) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pipe the key on stdin, e.g. printf %s "$OPENAI_API_KEY" | orca speech openai-key set'
    )
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > MAX_KEY_BYTES) {
      throw new RuntimeClientError('invalid_argument', 'That is too long to be an OpenAI key')
    }
    chunks.push(buffer)
  }
  const key = Buffer.concat(chunks).toString('utf8').trim()
  if (!key) {
    throw new RuntimeClientError('invalid_argument', 'No key on stdin')
  }
  return key
}

export const SPEECH_HANDLERS: Record<string, CommandHandler> = {
  'speech openai-key status': async ({ client, json }) => {
    const result = await client.call<OpenAiSpeechKeyStatus>('speech.openAiKey.status')
    printResult(result, json, formatKeyStatus)
  },
  'speech openai-key set': async ({ client, json }) => {
    const apiKey = await readOpenAiKeyFromStdin()
    const result = await client.call<OpenAiSpeechKeyStatus>('speech.openAiKey.set', { apiKey })
    printResult(result, json, formatKeyStatus)
  },
  'speech openai-key clear': async ({ client, json }) => {
    const result = await client.call<OpenAiSpeechKeyStatus>('speech.openAiKey.clear')
    printResult(result, json, formatKeyStatus)
  }
}
