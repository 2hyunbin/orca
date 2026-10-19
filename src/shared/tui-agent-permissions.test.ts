import { describe, expect, it } from 'vitest'
import {
  applyAgentPermissionMode,
  resolveAgentPermissionModeSummary,
  resolveTuiAgentPermissionMode,
  AUTO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from './tui-agent-permissions'

describe('tui agent permissions', () => {
  it.each(['yolo', 'manual'] as const)(
    'applies auto to supporting agents while preserving the %s policy elsewhere',
    (mode) => {
      const previous = applyAgentPermissionMode({ mode })
      const automatic = applyAgentPermissionMode({ mode: 'auto', ...previous })

      expect(automatic.agentDefaultArgs).toMatchObject(AUTO_TUI_AGENT_ARGS)
      expect(automatic.agentDefaultArgs.gemini).toBe(previous.agentDefaultArgs.gemini)
      expect(automatic.agentDefaultEnv).toEqual(previous.agentDefaultEnv)
      expect(resolveAgentPermissionModeSummary(automatic)).toBe('auto')
      expect(applyAgentPermissionMode({ mode, ...automatic })).toEqual(previous)
    }
  )

  it('recognizes manually configured auto arguments for each supporting agent', () => {
    for (const agent of ['claude', 'claude-agent-teams', 'codex'] as const) {
      expect(resolveTuiAgentPermissionMode({ agent, agentArgs: AUTO_TUI_AGENT_ARGS[agent] })).toBe(
        'auto'
      )
    }
  })

  it('preserves custom arguments and reports a partially automatic profile as mixed', () => {
    const automatic = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: { claude: '--model sonnet' }
    })
    expect(automatic.agentDefaultArgs.claude).toBe('--model sonnet')
    expect(automatic.agentDefaultArgs.codex).toBe('--approve-for-me')
    expect(resolveAgentPermissionModeSummary(automatic)).toBe('mixed')
  })

  it('keeps a custom unsupported agent visible as mixed in an otherwise auto profile', () => {
    const automatic = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: { gemini: '--model custom' }
    })
    expect(resolveAgentPermissionModeSummary(automatic)).toBe('mixed')
  })

  it('recognizes the current default profile as yolo', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })
    ).toBe('yolo')
  })

  it('recognizes an empty profile as manual', () => {
    expect(resolveAgentPermissionModeSummary({ agentDefaultArgs: {}, agentDefaultEnv: {} })).toBe(
      'manual'
    )
  })

  it('preserves custom agent arguments when applying manual mode', () => {
    const result = applyAgentPermissionMode({
      mode: 'manual',
      agentDefaultArgs: {
        claude: '--dangerously-skip-permissions',
        codex: '--model gpt-5'
      },
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })

    expect(result.agentDefaultArgs.claude).toBe('')
    expect(result.agentDefaultArgs.codex).toBe('--model gpt-5')
    expect(result.agentDefaultEnv.goose).toEqual({})
  })

  it('reports mixed when custom arguments are present', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: {
          ...YOLO_TUI_AGENT_ARGS,
          codex: '--model gpt-5'
        },
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })
    ).toBe('mixed')
  })

  it('resolves one Codex yolo launch as yolo', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'codex',
        agentArgs: YOLO_TUI_AGENT_ARGS.codex,
        agentEnv: {}
      })
    ).toBe('yolo')
  })

  it('resolves one empty Codex launch as manual', () => {
    expect(resolveTuiAgentPermissionMode({ agent: 'codex', agentArgs: '', agentEnv: {} })).toBe(
      'manual'
    )
  })

  it('switches Muse between yolo and manual arguments', () => {
    expect(
      applyAgentPermissionMode({
        mode: 'yolo',
        agentDefaultArgs: { muse: '' },
        agentDefaultEnv: {}
      }).agentDefaultArgs.muse
    ).toBe('--yolo')
    expect(
      applyAgentPermissionMode({
        mode: 'manual',
        agentDefaultArgs: { muse: '--yolo' },
        agentDefaultEnv: {}
      }).agentDefaultArgs.muse
    ).toBe('')
  })

  it('resolves custom Codex permission arguments as mixed', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'codex',
        agentArgs: '--ask-for-approval on-request',
        agentEnv: {}
      })
    ).toBe('mixed')
  })

  it('resolves env-driven yolo launches', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'goose',
        agentArgs: '',
        agentEnv: YOLO_TUI_AGENT_ENV.goose
      })
    ).toBe('yolo')
  })
})
