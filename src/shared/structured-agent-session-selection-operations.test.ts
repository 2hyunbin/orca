import { describe, expect, it, vi } from 'vitest'
import { createStructuredSessionSelectionController } from './structured-agent-session-selection-operations'

// Creation, attachment and revalidation share identities even when two picks have equal values.
describe('chat selection operation handoff', () => {
  it('keeps the frozen opening choice and skips a queued obsolete hold before a newer attached pick', async () => {
    const remember = vi.fn()
    const controller = createStructuredSessionSelectionController(remember)
    const opening = controller.issue('model', 'opus', null)
    const frozen = controller.freeze()
    const model = controller.issue('model', 'sonnet', null)
    const oldEffort = controller.issue('effort', 'high', 'sonnet')
    const modelReply = Promise.withResolvers<void>()
    const send = vi.fn(async (op) => {
      if (op === model) {
        await modelReply.promise
      }
      return { kind: 'accepted' as const, options: { [op.key]: op.value } }
    })
    const sending = controller.flush(send)
    await Promise.resolve()
    const newerEffort = controller.issue('effort', 'low', 'sonnet')
    const newerModel = controller.issue('model', 'opus', null)
    const fast = controller.issue('fastMode', 'true', 'opus')
    void controller.flush(send)
    controller.settle(frozen[0]!, { kind: 'accepted', options: { model: 'opus' } })
    expect(frozen).toEqual([opening])
    expect(controller.overlay()).toEqual({ model: 'opus', effort: 'low', fastMode: 'true' })
    expect(controller.pending()).toContain(newerModel)
    await expect(oldEffort.result).resolves.toEqual({ kind: 'superseded' })
    const beforeCompletion = controller.captureRead()
    modelReply.resolve()
    await sending
    expect(send.mock.calls.map(([op]) => op)).toEqual([model, newerModel, newerEffort, fast])
    controller.retire(beforeCompletion)
    expect(controller.overlay()).toEqual({ model: 'opus', effort: 'low', fastMode: 'true' })
    // The next complete answer can contain another client's newer values; equality is irrelevant.
    controller.retire(controller.captureRead())
    expect(controller.overlay()).toEqual({})
    expect(
      remember.mock.calls
        .flatMap(([picks]) => picks)
        .some((pick) => pick.optionId === 'effort' && pick.value === 'high')
    ).toBe(false)
  })

  it('orders accepted defaults independently by model and field without letting an old reply adopt its model', () => {
    const remember = vi.fn()
    const controller = createStructuredSessionSelectionController(remember)
    const oldEffort = controller.issue('effort', 'low', 'sonnet')
    oldEffort.transmitted = true
    const newModel = controller.issue('model', 'opus', null)
    const fast = controller.issue('fastMode', 'true', 'opus')
    const newEffort = controller.issue('effort', 'high', 'sonnet')
    controller.settle(fast, { kind: 'accepted', options: { fastMode: 'true' } })
    controller.settle(newModel, { kind: 'accepted', options: { model: 'opus' } })
    controller.settle(newEffort, {
      kind: 'accepted',
      options: { model: 'unrelated-later-model', effort: 'high' }
    })
    controller.settle(oldEffort, { kind: 'accepted', options: { effort: 'low' } })
    expect(remember.mock.calls.flatMap(([picks]) => picks)).toEqual([
      { modelId: 'opus', optionId: 'fastMode', value: true },
      { modelId: 'opus', optionId: 'model', value: 'opus', adoptModelAsLaunchDefault: false },
      { modelId: 'sonnet', optionId: 'effort', value: 'high' }
    ])
  })
})
