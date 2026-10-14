import { ENVIRONMENT_RECIPE_INPUT_BYTES } from '../.orca-tooling/dist/runtime.mjs'
import { handleProviderRequest } from './provider-client.mjs'

try {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk)
    if (size > ENVIRONMENT_RECIPE_INPUT_BYTES) {
      throw new Error('Request exceeded its byte limit')
    }
    chunks.push(Buffer.from(chunk))
  }
  const request = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  )
  const response = await handleProviderRequest(request, process.env)
  process.stdout.write(JSON.stringify(response))
} catch {
  process.stderr.write('Provider request or backend response could not be confirmed.\n')
  process.exitCode = 1
}
