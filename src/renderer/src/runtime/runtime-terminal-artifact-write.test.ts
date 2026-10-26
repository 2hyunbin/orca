import { describe, expect, it } from 'vitest'
import { writeRuntimeTerminalArtifactFile } from './runtime-terminal-artifact-write'
import {
  fsWriteFile,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment,
  type RuntimeRpcRequest
} from './runtime-file-client-test-harness'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'

installRuntimeFileClientEnvironment()

const PATH = '/private/tmp/handoff.md'
const meta = { runtimeId: 'remote-runtime' }
const ok = (result: unknown) => ({ id: 'rpc', ok: true, result, _meta: meta })
const refused = (message: string) => ({
  id: 'rpc',
  ok: false,
  error: { code: 'runtime_error', message },
  _meta: meta
})
const read = (content: string) =>
  ok({ worktree: 'wt-1', relativePath: PATH, content, truncated: false, byteLength: 1 })
const granted = (grantId: string) =>
  ok({
    worktree: 'wt-1',
    relativePath: null,
    absolutePath: PATH,
    exists: true,
    isDirectory: false,
    openTarget: { kind: 'absolute-file', provider: 'local', absolutePath: PATH, grantId }
  })

function save(content: string, baseline: string) {
  return writeRuntimeTerminalArtifactFile({
    target: { kind: 'environment', environmentId: 'env-1' },
    worktreeId: 'wt-1',
    absolutePath: PATH,
    grantId: 'g-1',
    content,
    precondition: { expectedSignature: getDiskBaselineSignature(baseline), allowMissing: false }
  })
}

function callsTo(method: string): RuntimeRpcRequest[] {
  return runtimeEnvironmentCall.mock.calls.map(([call]) => call).filter((c) => c.method === method)
}

describe('saving a granted host file outside every workspace', () => {
  it('writes through the grant when the host still holds the opened text', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method }) =>
      method === 'files.readTerminalArtifact' ? read('# old') : ok({ ok: true })
    )

    await expect(save('# new', '# old')).resolves.toEqual({ ok: true })

    expect(callsTo('files.writeTerminalArtifact')[0]?.params).toEqual({
      worktree: 'id:wt-1',
      grantId: 'g-1',
      absolutePath: PATH,
      content: '# new'
    })
    // Why: a host path must never become a write of this computer's same path.
    expect(fsWriteFile).not.toHaveBeenCalled()
  })

  it('refuses to overwrite text that changed on the host', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method }) =>
      method === 'files.readTerminalArtifact' ? read('# theirs') : ok({ ok: true })
    )

    await expect(save('# new', '# old')).resolves.toEqual({ ok: false, diskConflict: 'changed' })
    expect(callsTo('files.writeTerminalArtifact')).toHaveLength(0)
  })

  it('renews an expired grant and still checks the host text first', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method, params }) => {
      if (method === 'files.resolveTerminalPath') {
        return granted('g-2')
      }
      const grantId = (params as { grantId?: string }).grantId
      if (grantId === 'g-1') {
        return refused('terminal_file_grant_expired')
      }
      return method === 'files.readTerminalArtifact' ? read('# old') : ok({ ok: true })
    })

    await expect(save('# new', '# old')).resolves.toEqual({ ok: true })

    expect(callsTo('files.resolveTerminalPath')[0]?.params).toEqual({
      worktree: 'id:wt-1',
      pathText: PATH,
      crossWorkspace: true
    })
    expect(callsTo('files.writeTerminalArtifact').map((c) => c.params)).toEqual([
      expect.objectContaining({ grantId: 'g-2', content: '# new' })
    ])
  })
})
