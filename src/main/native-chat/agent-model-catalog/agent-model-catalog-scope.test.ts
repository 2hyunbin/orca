import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogStore } from './agent-model-catalog-store'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeModelCatalogProbe } from '../../claude/claude-model-catalog-probe'
import { createCodexModelCatalogProbe } from '../../codex/codex-model-catalog-probe'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from './agent-model-catalog-fingerprint'

describe('installed catalog invocation identity', () => {
  it.each(['claude', 'codex'] as const)(
    'keeps %s scope stable across shell captures while distinguishing launch inputs',
    async (agent) => {
      let capture = 'first'
      let catalogFile = '/catalog/A.json'
      const overlay = () => ({ CATALOG_FILE: catalogFile })
      let command = '/installed/agent'
      const launchArgs = (name: string) =>
        agent === 'claude'
          ? ['--settings', JSON.stringify({ model: name })]
          : ['--config', `model_provider="${name}"`]
      let args = launchArgs('work')
      const environment = () => ({ SSH_AUTH_SOCK: `/ssh/${capture}`, SSH_AGENT_PID: capture })
      const probe =
        agent === 'claude'
          ? createClaudeModelCatalogProbe({
              resolveCommand: () => command,
              resolveInheritedEnv: async () => environment(),
              resolveEnv: overlay,
              resolveAuthPolicy: () => ({ account: 'system' }),
              resolveLaunchArgs: () => args
            })
          : createCodexModelCatalogProbe({
              resolveCommand: () => command,
              resolveEnvironment: async () => environment(),
              resolveEnv: overlay,
              resolveLaunchArgs: () => args
            })
      const key = async (account = '/account', cwd = '/project') => {
        const home = {
          variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
          path: account
        }
        const resolved = await probe.resolve?.(home, cwd)
        expect(resolved).toBeDefined()
        const base = agentModelCatalogFingerprint({ agent, accountHome: home, wslDistro: null })
        return agentModelCatalogScopeFingerprint(base, cwd, resolved?.identity)
      }
      const first = await key()
      capture = 'second'
      expect(await key()).toBe(first)
      catalogFile = '/catalog/B.json'
      expect(await key()).not.toBe(first)
      catalogFile = '/catalog/A.json'
      expect(await key()).toBe(first)
      expect(await key('/other-account')).not.toBe(first)
      expect(await key('/account', '/other-project')).not.toBe(first)
      command = '/other/agent'
      expect(await key()).not.toBe(first)
      command = '/installed/agent'
      args = launchArgs('personal')
      expect(await key()).not.toBe(first)
    }
  )
})

describe('original operation through actual nested resolution', () => {
  it.each(['overlay', 'environment', 'auth'] as const)(
    'starts no stage after %s resolves beyond the original deadline',
    async (held) => {
      vi.useFakeTimers()
      const gate = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const stages: string[] = []
      const stage = async (name: string) => {
        stages.push(name)
        if (name === held) {
          entered.resolve()
          await gate.promise
        }
      }
      const runListing = vi.fn(async () => '')
      const probe = createClaudeModelCatalogProbe({
        resolveLaunchArgs: () => [],
        resolveEnv: async () => {
          await stage('overlay')
          return {}
        },
        resolveInheritedEnv: async () => {
          await stage('environment')
          return { PATH: '/fixture' }
        },
        resolveCommand: () => {
          stages.push('lookup')
          return '/fixture/claude'
        },
        resolveAuthPolicy: async () => {
          await stage('auth')
          return { account: 'system' }
        },
        runListing
      })
      const record = agentSessionRecordFixture({
        provider: 'claude',
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/fixture/account' }
      })
      const store = new AgentModelCatalogStore()
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => record,
        drivesRecord: () => true,
        resolveAccountHome: async () => record.accountHome,
        recordWorkspacePath: async () => '/fixture/workspace',
        probes: { claude: probe }
      })
      try {
        const demand = service.demand({
          agent: 'claude',
          sessionId: record.sessionId,
          deadline: Date.now() + 10
        })
        await entered.promise
        const before = [...stages]
        await vi.advanceTimersByTimeAsync(11)
        await demand
        gate.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(stages).toEqual(before)
        expect(runListing).not.toHaveBeenCalled()
        expect(service.snapshot({ agent: 'claude', sessionId: record.sessionId })).toEqual({
          origin: 'unknown'
        })
      } finally {
        gate.resolve()
        service.stop()
        vi.useRealTimers()
      }
    }
  )
})
