import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { planEntry, planOf, planOp } from '../skills/bundled-skill-plan-fixtures.test-support'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'

const useDetectedAgents = vi.fn(() => ({
  detectedIds: ['claude', 'codex'],
  isLoading: false,
  isRefreshing: false,
  refresh: vi.fn()
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: (...args: unknown[]) => useDetectedAgents(...(args as []))
}))

describe('OrchestrationSkillAgentCoverage', () => {
  it('shows each detected agent with an explicit skill status', () => {
    const markup = renderToStaticMarkup(
      <OrchestrationSkillAgentCoverage
        loading={false}
        sources={[
          {
            id: 'claude-home',
            label: 'Claude Code home',
            path: '/Users/test/.claude/skills',
            sourceKind: 'home',
            providers: ['claude'],
            owner: 'claude',
            exists: true
          }
        ]}
        skills={[
          {
            id: 'claude-skill',
            name: 'orchestration',
            description: null,
            providers: ['claude'],
            sourceKind: 'home',
            sourceLabel: 'Claude Code home',
            rootPath: '/Users/test/.claude/skills',
            directoryPath: '/Users/test/.claude/skills/orchestration',
            skillFilePath: '/Users/test/.claude/skills/orchestration/SKILL.md',
            installed: true,
            updatedAt: null
          }
        ]}
      />
    )

    expect(markup).toContain('Claude')
    expect(markup).toContain('Codex')
    expect(markup).toContain('Ready')
    expect(markup).toContain('Missing')
    expect(markup).not.toContain('View details')
    // Why: an omitted target reads as "host unknown", which pins detectedIds to
    // null and leaves the widget spinning forever.
    expect(useDetectedAgents).toHaveBeenCalledWith({ kind: 'local' })
  })
})

it('uses the install plan to mark an agent missing even when discovery finds a shared copy', () => {
  const markup = renderToStaticMarkup(
    <OrchestrationSkillAgentCoverage
      loading={false}
      plan={planOf([
        planEntry('orchestration', [
          planOp('keep', '/home/u/.agents/skills/orchestration'),
          planOp('link', '/home/u/.claude/skills/orchestration', { agents: ['claude'] })
        ])
      ])}
      sources={['claude', 'codex'].map((owner) => ({
        id: owner,
        label: owner,
        path: '/home/u/.agents/skills',
        sourceKind: 'home',
        providers: [],
        owner,
        exists: true
      }))}
      skills={[
        {
          id: 'skill',
          name: 'orchestration',
          description: null,
          providers: ['claude', 'codex'],
          sourceKind: 'home',
          sourceLabel: 'Shared',
          rootPath: '/home/u/.agents/skills',
          directoryPath: '/home/u/.agents/skills/orchestration',
          skillFilePath: '/home/u/.agents/skills/orchestration/SKILL.md',
          installed: true,
          updatedAt: null
        }
      ]}
    />
  )
  expect(markup).toContain('1 of 2 detected agents have the skill.')
  expect(markup).toContain('Missing')
  expect(markup).not.toContain('All 2 detected agents')
})
