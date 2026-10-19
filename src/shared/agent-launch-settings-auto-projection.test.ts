import { describe, expect, it } from 'vitest'
import { projectAgentLaunchSettings } from './agent-launch-settings'
import { applyAgentPermissionMode } from './tui-agent-permissions'

describe('agent launch permission projection compatibility', () => {
  it('publishes Auto through an optional marker alongside the existing Mixed value', () => {
    const settings = projectAgentLaunchSettings(applyAgentPermissionMode({ mode: 'auto' }))
    expect(settings.permissionMode).toBe('mixed')
    expect(settings.autoPermissionMode).toBe(true)
    expect(settings.agentDefaultArgs.codex).toBe('--approve-for-me')
    expect(settings.agentDefaultArgs.claude).toBe('--permission-mode auto')
  })

  it.each(['yolo', 'manual'] as const)('preserves the existing %s projection', (mode) => {
    const settings = projectAgentLaunchSettings(applyAgentPermissionMode({ mode }))
    expect(settings.permissionMode).toBe(mode)
    expect(settings).not.toHaveProperty('autoPermissionMode')
  })

  it('does not label a partly configured automatic profile as Auto', () => {
    const settings = projectAgentLaunchSettings({ agentDefaultArgs: { codex: '--approve-for-me' } })
    expect(settings.permissionMode).toBe('mixed')
    expect(settings).not.toHaveProperty('autoPermissionMode')
  })
})
