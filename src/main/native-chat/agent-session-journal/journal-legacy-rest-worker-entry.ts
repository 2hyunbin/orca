import { parentPort, workerData } from 'node:worker_threads'
import { openLegacyRestReader } from './journal-legacy-rest-reader'
import { LegacyRestReplay } from './journal-legacy-rest-worker-replay'
import {
  legacyRestPermitted,
  type LegacyRestRequest,
  type LegacyRestResponse
} from './journal-legacy-rest-worker-protocol'

const port = parentPort
if (!port) {
  throw new Error('legacy replay requires a worker port')
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The same-binary factory sends its string stateDirectory and shared Int32Array control; Node's workerData declaration erases that private payload type.
const { directory, control } = workerData as { directory: string; control: Int32Array }
let db: ReturnType<typeof openLegacyRestReader> | undefined
let replay: LegacyRestReplay | undefined
port.on('message', (request: LegacyRestRequest) => {
  const permitted = () => legacyRestPermitted(control, request.generation)
  if (!permitted()) {
    const response: LegacyRestResponse = {
      id: request.id,
      generation: request.generation,
      sessionId: request.sessionId,
      guard: request.source?.guard ?? '',
      status: 'paused',
      cursor: 0,
      pending: false,
      occupiedMs: 0
    }
    port.postMessage(response)
    return
  }
  const started = performance.now()
  let setupMs = 0
  if (!replay) {
    db = openLegacyRestReader(directory)
    replay = new LegacyRestReplay(db, directory)
    setupMs = performance.now() - started
  }
  const response = replay.grant(request, permitted, setupMs)
  port.postMessage(response)
})
port.on('close', () => {
  replay?.close()
  db?.close()
})
