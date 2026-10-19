import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import { AgentHookServer, _internals } from '../agent-hooks/server'
import { buildBody, PANE } from '../agent-hooks/server.test-fixtures'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const TAB: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: 'tab-1::leaf',
  parentTabId: 'tab-1',
  leafId: 'leaf',
  title: 'Claude Code',
  isActive: true
}

// A headless host's PTY whose idle agent title landed after the hook row.
function idleTitlePty(titleEpochMs: number): RuntimePtyWorktreeRecord {
  return {
    ptyId: 'pty-1',
    incarnationId: null,
    worktreeId: 'wt-1',
    connectionId: null,
    runtimeSessionOwned: true,
    isWsl: null,
    wslDistro: null,
    tabId: 'tab-1',
    paneKey: PANE,
    surfaceRecordedAtGraphSequence: 0,
    launchConfig: null,
    launchToken: null,
    launchIncarnationId: null,
    launchAgent: 'claude',
    agentSessionOwners: [],
    foregroundAgent: 'claude',
    connected: true,
    disconnectedAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastAgentStatusStartedAtEpochMs: titleEpochMs,
    lastAgentStatusRichInvalidatedAtEpochMs: null,
    lastOscTitle: '✳ Claude Code',
    lastOscTitleAt: 1,
    lastOscTitleEpochMs: titleEpochMs,
    managementTitle: null,
    managementTitleAt: null,
    controllerTitle: null,
    title: '✳ Claude Code',
    titleUpdatedAt: 1,
    lastOutputAt: null,
    tailBuffer: [],
    tailTranscriptBuffer: [],
    tailTranscriptChars: 0,
    tailPartialLine: '',
    tailPendingAnsi: '',
    tailRedrawCursor: null,
    tailTruncated: false,
    tailLinesTotal: 0,
    preview: '',
    waitBlockedAt: null
  }
}

async function postClaudeHook(
  server: AgentHookServer,
  payload: Record<string, unknown>
): Promise<void> {
  const env = server.buildPtyEnv()
  await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(buildBody(payload))
  })
}

describe('headless host publication keeps the file-activity stamp', () => {
  beforeEach(() => {
    _internals.resetCachesForTests()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('under an idle title that arrived after the turn-end hook', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postClaudeHook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'edit via mcp' })
      await postClaudeHook(server, {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__files__write',
        tool_input: {},
        tool_response: {}
      })
      await postClaudeHook(server, { hook_event_name: 'Stop', background_tasks: [] })
      const rows = server.getStatusSnapshot()
      const stamp = rows[0]?.fileActivityAt
      expect(stamp).toEqual(expect.any(Number))

      const result = buildRuntimeMobileAgentStatus(
        idleTitlePty(Date.now() + 1_000),
        TAB,
        null,
        null,
        (paneKey) => rows.filter((row) => row.paneKey === paneKey),
        { getPaneKey: () => PANE, getLeaf: () => null, getTrackedTitle: () => null }
      )
      expect(result.agentStatus).toMatchObject({ fileActivityAt: stamp, fileActivityKind: 'turn' })
    } finally {
      server.stop()
    }
  })
})
