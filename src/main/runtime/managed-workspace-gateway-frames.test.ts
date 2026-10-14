import { expect, it } from 'vitest'
import {
  managedWorkspaceRequestFrame,
  managedWorkspaceBinaryFrame,
  parseManagedWorkspaceRequest
} from './managed-workspace-gateway-frames'
import {
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  TerminalStreamOpcode
} from '../../shared/terminal-stream-protocol'

it('remaps declared terminal identities while preserving commands and file contents', () => {
  const request = parseManagedWorkspaceRequest(
    JSON.stringify({
      id: 'one',
      method: 'terminal.send',
      deviceToken: 'outer',
      authToken: 'owner',
      executionHost: 'root',
      params: {
        text: 'outer',
        contents: 'a file with outer',
        client: { id: 'outer' },
        clientId: 'outer',
        subscriptionId: 'terminal:outer'
      }
    })
  )
  expect(JSON.parse(managedWorkspaceRequestFrame(request, 'outer', 'child-id'))).toEqual({
    id: 'one',
    method: 'terminal.send',
    params: {
      text: 'outer',
      contents: 'a file with outer',
      client: { id: 'child-id' },
      clientId: 'child-id',
      subscriptionId: 'terminal:child-id'
    }
  })
})
it('does not reinterpret identity-like fields in unrelated file operations', () => {
  const request = parseManagedWorkspaceRequest(
    JSON.stringify({
      id: 'two',
      method: 'files.write',
      params: { clientId: 'outer', contents: 'outer' }
    })
  )
  expect(JSON.parse(managedWorkspaceRequestFrame(request, 'outer', 'child-id'))).toEqual({
    id: 'two',
    method: 'files.write',
    params: { clientId: 'outer', contents: 'outer' }
  })
})
it.each(['null', '[]', '{"id":"one"}', '{"method":"status.get","id":1}'])(
  'refuses malformed request %s',
  (frame) => {
    expect(() => parseManagedWorkspaceRequest(frame)).toThrow()
  }
)
it('remaps multiplex subscribe fields without changing stream identity or input bytes', () => {
  const subscribe = encodeTerminalStreamFrame({
    streamId: 7,
    opcode: TerminalStreamOpcode.Subscribe,
    seq: 3,
    payload: encodeTerminalStreamJson({ client: { id: 'outer' }, terminal: 'term' })
  })
  const remapped = decodeTerminalStreamFrame(
    managedWorkspaceBinaryFrame(subscribe, 'outer', 'child-id')
  )
  expect(remapped).toMatchObject({ streamId: 7, opcode: TerminalStreamOpcode.Subscribe, seq: 3 })
  expect(remapped && decodeTerminalStreamJson<unknown>(remapped.payload)).toEqual({
    client: { id: 'child-id' },
    terminal: 'term'
  })
  const input = encodeTerminalStreamFrame({
    streamId: 7,
    opcode: TerminalStreamOpcode.Input,
    seq: 4,
    payload: new TextEncoder().encode('outer')
  })
  expect(managedWorkspaceBinaryFrame(input, 'outer', 'child-id')).toBe(input)
})
