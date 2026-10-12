import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { AgentPromptActivity } from '../../agent-prompt-submission-verification'

const activity: AgentPromptActivity = {
  generation: 0,
  permissionSequence: 0,
  workingSequence: 0,
  explicitWorkingStartedAt: null,
  outputSequence: 0,
  status: null
}

const cases: {
  name: string
  invoke: (runtime: OrcaRuntimeService) => unknown
  kind: 'sync' | 'promise' | 'throw'
  expected: unknown
}[] = [
  {
    name: 'structured worker pane lookup',
    invoke: (runtime) => runtime.getStructuredWorkerPaneKeyForSession('missing'),
    kind: 'sync',
    expected: null
  },
  {
    name: 'settled prompt agent lookup',
    invoke: (runtime) => runtime.isTerminalRunningSettledPromptAgent('missing'),
    kind: 'promise',
    expected: false
  },
  {
    name: 'prompt lifecycle recording',
    invoke: (runtime) => runtime['recordAgentPromptLifecycleState']('missing', null),
    kind: 'sync',
    expected: undefined
  },
  {
    name: 'permission observation recording',
    invoke: (runtime) => runtime['recordAgentPromptPermissionObservation']('missing'),
    kind: 'sync',
    expected: undefined
  },
  {
    name: 'prompt title byte order restoration',
    invoke: (runtime) => runtime['restoreAgentPromptLifecycleByteOrder']('missing', '', null),
    kind: 'sync',
    expected: undefined
  },
  {
    name: 'OpenCode startup prompt ownership',
    invoke: (runtime) => runtime.readOpenCodeStartupPromptOwner('missing', 'incarnation', 'token'),
    kind: 'sync',
    expected: null
  },
  {
    name: 'terminal transport host platform',
    invoke: (runtime) => runtime['getPtyWriteHostPlatform']('missing'),
    kind: 'sync',
    expected: process.platform
  },
  {
    name: 'terminal agent lookup',
    invoke: (runtime) => runtime['getPtyAgent']('missing'),
    kind: 'sync',
    expected: null
  },
  {
    name: 'permission admission',
    invoke: (runtime) => runtime['assertAgentPromptPermissionSafe'](activity, activity),
    kind: 'sync',
    expected: undefined
  },
  {
    name: 'permission refusal',
    invoke: (runtime) =>
      runtime['assertAgentPromptPermissionSafe'](activity, {
        ...activity,
        status: 'permission',
        permissionSequence: 1
      }),
    kind: 'throw',
    expected: 'agent_prompt_blocked'
  },
  {
    name: 'generation refusal',
    invoke: (runtime) => runtime['assertAgentPromptGeneration']('missing', 0),
    kind: 'throw',
    expected: 'terminal_handle_stale'
  },
  {
    name: 'explicit status for a handle',
    invoke: (runtime) => runtime['getFreshExplicitAgentStatusForHandle']('missing', 'pane'),
    kind: 'sync',
    expected: null
  },
  {
    name: 'explicit status for a terminal',
    invoke: (runtime) => runtime['getFreshExplicitAgentStatusForPty']('missing', 'missing'),
    kind: 'sync',
    expected: null
  },
  {
    name: 'prompt activity refusal',
    invoke: (runtime) => runtime['getAgentPromptActivity']('missing', 'missing'),
    kind: 'throw',
    expected: 'runtime_unavailable'
  },
  {
    name: 'hook presence lookup',
    invoke: (runtime) => runtime['recheckHookAgentPresenceForPty']('missing'),
    kind: 'promise',
    expected: null
  },
  {
    name: 'agent exit confirmation',
    invoke: (runtime) => runtime['confirmPtyAgentExit']('missing'),
    kind: 'sync',
    expected: undefined
  },
  {
    name: 'foreground title snapshot policy',
    invoke: (runtime) =>
      runtime['shouldDelayPtyBackedMobileSnapshotForForegroundAgent'](
        runtime['recordPtyWorktree']('constructor-pty', 'constructor-workspace'),
        ''
      ),
    kind: 'sync',
    expected: false
  }
]

describe('terminal status during runtime construction', () => {
  it.each(cases)(
    'preserves $name at the original getter seam',
    async ({ invoke, kind, expected }) => {
      let result: unknown
      let failure: unknown
      class StatusConstructorProbe extends OrcaRuntimeService {
        protected override get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
          try {
            result = invoke(this)
          } catch (error) {
            failure = error
          }
          return super.canonicalFetchKeyCache
        }
      }
      expect(() => new StatusConstructorProbe(null)).not.toThrow()
      if (kind === 'throw') {
        expect(failure).toBeInstanceOf(Error)
        expect(failure).toHaveProperty('message', expected)
      } else {
        expect(failure).toBeUndefined()
        expect(result instanceof Promise).toBe(kind === 'promise')
        expect(await result).toEqual(expected)
      }
    }
  )
})
