import type { NdjsonRejectedRecord } from '../../shared/main-process-ndjson-framer'

/** A reply over the line cap, refused for the one request that asked to survive it. */
export class JsonlRpcReplyTooLargeError extends Error {
  constructor(
    readonly command: string,
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(`Agent reply to ${command} exceeded ${maxBytes} bytes`)
    this.name = 'JsonlRpcReplyTooLargeError'
  }
}

export type JsonlRpcRequestOptions = {
  timeoutMs?: number | null
  /** An optional read whose oversized reply fails only itself instead of the stream. */
  oversizedReply?: 'reject'
}

// The head Pi writes before any data (`{id, type, command, success, data}`), with Orca's own ids.
const OVERSIZED_REPLY_HEAD = /^\{"id":"(orca-\d+)","type":"response","command":"([a-z_]+)"/

/**
 * The request an oversized line answers, and the error it gets instead of the stream ending: only
 * a reply to a request that opted in, on a line the framer drops whole. Anything else could carry
 * session or tool lifecycle evidence. A paused reader's queue overflow reports its own limit, having
 * dropped complete records, so it never qualifies.
 */
export function oversizedReplyRequest(
  rejected: Extract<NdjsonRejectedRecord, { kind: 'line-too-long' }>,
  lineLimit: number,
  pending: ReadonlyMap<string, { command: string; oversizedReply?: 'reject' }>
): { id: string; error: JsonlRpcReplyTooLargeError } | null {
  const head = OVERSIZED_REPLY_HEAD.exec(rejected.prefix)
  const request = head ? pending.get(head[1]) : undefined
  if (!head || rejected.maxLineBytes !== lineLimit || request?.oversizedReply !== 'reject') {
    return null
  }
  if (request.command !== head[2]) {
    return null
  }
  return {
    id: head[1],
    error: new JsonlRpcReplyTooLargeError(request.command, rejected.observedBytes, lineLimit)
  }
}
