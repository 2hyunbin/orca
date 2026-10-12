import './rpc/unused-default-rpc-methods.test-fixture'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'

describe('floating workspace file target resolution', () => {
  it('captures the converter before awaiting the path and keeps its runtime receiver', async () => {
    const runtime = new OrcaRuntimeService()
    const pending = Promise.withResolvers<string>()
    const events: string[] = []
    const convert = runtime['floatingWorkspaceToResolvedWorktree']
    const original = vi.fn(function (this: OrcaRuntimeService, path: string) {
      events.push('invoke original')
      expect(this).toBe(runtime)
      return convert.call(this, path)
    })
    const replacement = vi.fn((path: string) => convert.call(runtime, path))
    let converter: typeof convert = original
    Object.defineProperty(runtime, 'floatingWorkspaceToResolvedWorktree', {
      get: () => {
        events.push('capture converter')
        return converter
      }
    })
    Object.defineProperty(runtime, 'resolveFloatingWorkspacePath', {
      value: () => {
        events.push('resolve path')
        return pending.promise
      }
    })
    const result = runtime['resolveRuntimeFileTarget'](FLOATING_TERMINAL_WORKTREE_ID)
    converter = replacement
    const path = join(tmpdir(), 'floating')
    pending.resolve(path)

    await expect(result).resolves.toMatchObject({
      worktree: { path },
      executionHostId: 'local'
    })
    expect(events).toEqual(['capture converter', 'resolve path', 'invoke original'])
    expect(original).toHaveBeenCalledWith(path)
    expect(replacement).not.toHaveBeenCalled()
  })
})
