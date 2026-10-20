import { expect, it } from 'vitest'
import { acquired, fakeClaude, USER_MESSAGE } from './claude-structured-session-test-support'
import { recordAgentSessionRanOptions } from '../runtime/agent-session-record-options'
import {
  createQueuedMessageTestRig,
  eventually
} from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'

it.each(['low', 'high', undefined])(
  'admits accepted high independently of resolved effort (effective %s)',
  async (effective) => {
    const models = [
      {
        value: 'sonnet',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsFastMode: true
      }
    ]
    const claude = fakeClaude({
      initModels: models,
      routes: { list_models: () => models },
      settings: {
        ...(effective ? { applied: { model: 'sonnet', effort: 'low' } } : {}),
        effective: { effortLevel: effective, fastMode: false }
      }
    })
    const adapter = await acquired(claude)
    const rig = await createQueuedMessageTestRig()
    const choices = { model: 'sonnet', effort: 'high', fastMode: 'true' }
    try {
      rig.dispatch.mockImplementation(async () =>
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId: 'joined',
          body: USER_MESSAGE,
          executionOptions: choices,
          fence: 7
        })
      )
      const first = rig.send('first', undefined, { carried: choices })
      expect(await first.result).toMatchObject({ ok: true })
      await eventually(() =>
        expect(rig.store.getRecord(SESSION)?.options).toEqual({
          model: 'sonnet',
          ...(effective ? { effort: 'low' } : {})
        })
      )
      const outcome = await rig.dispatch.mock.results[0]!.value
      expect(outcome).toEqual({
        state: 'admitted',
        ranOptions: effective ? { model: 'sonnet', effort: 'low' } : {}
      })
      expect(outcome.ranOptions).not.toHaveProperty('fastMode')
      const record = rig.store.getRecord(SESSION)!
      expect(
        recordAgentSessionRanOptions(
          { ...record, options: { model: 'sonnet', effort: 'high' } },
          {
            sessionId: SESSION,
            fence: record.lease.runtimeFence,
            model: 'sonnet',
            options: outcome.ranOptions!,
            models: undefined,
            now: record.updatedAt
          }
        ).options
      ).toEqual({ model: 'sonnet', effort: 'high' })
      await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'again',
        body: USER_MESSAGE,
        executionOptions: choices,
        fence: 7
      })
      expect(
        claude.connections[0]!.calls.filter(
          (call) =>
            call.subtype === 'apply_flag_settings' && JSON.stringify(call.params).includes('high')
        )
      ).toHaveLength(1)
      expect(claude.connections[0]!.sent).toHaveLength(2)
    } finally {
      await adapter.closeAll()
      await rig.dispose()
    }
  }
)
