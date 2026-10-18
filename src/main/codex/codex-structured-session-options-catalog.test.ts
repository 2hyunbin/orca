import { describe, expect, it, vi } from 'vitest'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'

function modelRow(id: string) {
  return { model: id, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }
}

describe('Codex discovery deadline', () => {
  it('budgets all pages and config/read against one 30-second deadline', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const timeouts: number[] = []
    const request = vi.fn(
      async (
        method: string,
        _params?: Record<string, unknown>,
        options?: { timeoutMs?: number }
      ) => {
        timeouts.push(options?.timeoutMs ?? 0)
        if (method === 'model/list') {
          now += 15_001
          return { data: [modelRow('gpt-live')], nextCursor: timeouts.length === 1 ? 'more' : null }
        }
        return { config: {} }
      }
    )
    try {
      await expect(
        fetchCodexModelCatalogListing({ connection: { request }, deadlineMs: 30_000 })
      ).rejects.toThrow('deadline exceeded')
      expect(request.mock.calls.map(([method]) => method)).toEqual(['model/list', 'model/list'])
      expect(timeouts).toEqual([30_000, 14_999])
    } finally {
      clock.mockRestore()
    }
  })
})
