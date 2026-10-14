import { parseRemoteRuntimeJsonText } from '../../shared/remote-runtime-request-frames'
import {
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  TerminalStreamOpcode
} from '../../shared/terminal-stream-protocol'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseManagedWorkspaceRequest(frame: string): Record<string, unknown> & {
  id: string
  method: string
} {
  const parsed = parseRemoteRuntimeJsonText(frame)
  if (
    !record(parsed) ||
    typeof parsed.id !== 'string' ||
    !parsed.id ||
    typeof parsed.method !== 'string' ||
    !parsed.method
  ) {
    throw new Error('Invalid managed workspace request')
  }
  return { ...parsed, id: parsed.id, method: parsed.method }
}

function terminalClientFields(params: Record<string, unknown>, from: string, to: string) {
  const next = { ...params }
  for (const field of ['client', 'mobileClient']) {
    const client = next[field]
    if (record(client) && client.id === from) {
      next[field] = { ...client, id: to }
    }
  }
  if (next.clientId === from) {
    next.clientId = to
  }
  if (typeof next.subscriptionId === 'string' && next.subscriptionId.endsWith(`:${from}`)) {
    next.subscriptionId = next.subscriptionId.slice(0, -from.length) + to
  }
  return next
}

/** Remap identity fields without changing file contents, commands or arbitrary user text. */
export function managedWorkspaceRequestFrame(
  request: ReturnType<typeof parseManagedWorkspaceRequest>,
  from: string,
  to: string
): string {
  const {
    deviceToken: _token,
    authToken: _ownerToken,
    executionHost: _host,
    ...forwarded
  } = request
  return JSON.stringify({
    ...forwarded,
    ...(request.method.startsWith('terminal.') && record(request.params)
      ? { params: terminalClientFields(request.params, from, to) }
      : {})
  })
}

export function managedWorkspaceBinaryFrame(
  bytes: Uint8Array<ArrayBufferLike>,
  from: string,
  to: string
): Uint8Array<ArrayBufferLike> {
  const frame = decodeTerminalStreamFrame(bytes)
  if (frame?.opcode !== TerminalStreamOpcode.Subscribe) {
    return bytes
  }
  const payload = decodeTerminalStreamJson<unknown>(frame.payload)
  if (!record(payload)) {
    throw new Error('Invalid terminal subscription frame')
  }
  return encodeTerminalStreamFrame({
    ...frame,
    payload: encodeTerminalStreamJson(terminalClientFields(payload, from, to))
  })
}

export function managedWorkspaceFailureFrame(id: string, code: string, message: string): string {
  return JSON.stringify({ id, ok: false, error: { code, message } })
}
