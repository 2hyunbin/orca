import type { Project } from '../../shared/project-types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { statSyncMock } from './pty-ipc-mock-registry'
import {
  providerFacts,
  restoreMainPlatform,
  setMainPlatform,
  startParityLanes,
  spawnBoth
} from './pty-launch-parity.test-fixture'
import {
  POSIX_PATH,
  WIN_PATH,
  WSL_PATH
} from '../../shared/launch-parity-window-cases.test-fixture'
import {
  launchWorkspaceId,
  type LaunchWorkspace
} from '../../shared/launch-parity-window-request.test-fixture'
import { HOST_TAB_ID } from './pty-launch-parity-host.test-cases'
import { readOpenSshDefaultShell } from '../../shared/openssh-default-shell'
import { resolveLocalTerminalRuntime } from '../local-project-runtime-resolution'
import { assertMobileTerminalShellSupported } from '../runtime/terminal/launch/mobile-terminal-shell-refusal'

const POSIX_REPO = { kind: 'repo', path: POSIX_PATH } as const
const WSL_UBUNTU = { kind: 'wsl', distro: 'Ubuntu' } as const
// What the renderer sends for a WSL project (it reads a never-saved \\wsl$ path the same way).
const WSL_PROJECT_SENT = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
}
const LOGIN_SHELL = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`

export function registerWorkspaceRuntimeParityTests() {
  // Both callers must consume the owning host's workspace runtime.
  describe('spawn preflight: workspace runtime convergence', () => {
    const suite = setupPtyIpcSuite()
    afterEach(() => {
      restoreMainPlatform()
      vi.unstubAllEnvs()
    })

    it('describes the winning native shell after host policy changes during IPC recovery', async () => {
      setMainPlatform('win32')
      const workspace = { kind: 'repo', path: WIN_PATH, projectRuntime: WSL_UBUNTU } as const
      const projects: Pick<Project, 'id' | 'sourceRepoIds' | 'localWindowsRuntimePreference'>[] = [
        { id: 'project-1', sourceRepoIds: ['repo-1'], localWindowsRuntimePreference: WSL_UBUNTU }
      ]
      const lanes = startParityLanes(suite, { workspace, projects })
      const entered = Promise.withResolvers<void>()
      const recovery = Promise.withResolvers<boolean>()
      const spawn = vi.fn(async (options: { shellOverride?: string }) => ({
        id: 'observed-native',
        shellPath: options.shellOverride,
        wslDistro: null,
        incarnationId: '5b3b5ff4-23b1-4000-8000-000000000001'
      }))
      suite.installDaemonTestProvider({
        spawn,
        listProcesses: async () => [
          {
            id: 'observed-native',
            cwd: WIN_PATH,
            title: 'shell',
            shellPath: spawn.mock.calls[0]?.[0].shellOverride,
            wslDistro: null,
            incarnationId: '5b3b5ff4-23b1-4000-8000-000000000001'
          }
        ],
        routesFreshSpawnsToLocalProvider: true,
        recoverFreshSpawnRouting: () => {
          entered.resolve()
          return recovery.promise
        }
      })
      const { installIpcPtyWindow, restorePtySpecWindow } =
        await import('../../renderer/src/components/terminal-pane/pty-transport-test-harness')
      const { createIpcPtyTransport } =
        await import('../../renderer/src/components/terminal-pane/pty-transport')
      const { resolveTerminalInputHostPlatform } =
        await import('../../renderer/src/components/terminal-pane/terminal-input-host-platform')
      const { resolveTerminalPasteRuntime } =
        await import('../../renderer/src/components/terminal-pane/terminal-paste-runtime')
      const { isLocalWindowsConptyPaneForCtrlArrow } =
        await import('../../renderer/src/components/terminal-pane/terminal-ctrl-arrow-conpty')
      const { resolveDashboardCardTerminalInput } =
        await import('../../renderer/src/components/dashboard/dashboard-card-terminal-input')
      const { useAppStore } = await import('../../renderer/src/store')
      const { ShellIcon } = await import('../../renderer/src/components/tab-bar/shell-icons')
      const { Terminal } = await import('@xterm/headless')
      const { refreshPaneProcessCapabilities } =
        await import('../../renderer/src/components/terminal-pane/pty-connection/pane-host-capability-flags')
      const { bindCaptureTransportOutputCallbacks } =
        await import('../../renderer/src/components/terminal-pane/pty-connection/transport-output-callbacks')
      const { installPaneAgentIdentity } =
        await import('../../renderer/src/components/terminal-pane/pty-connection/pane-agent-identity')
      const { readTerminalTabShell } =
        await import('../../renderer/src/store/terminals/terminal-process-metadata')
      const { installTerminalCapabilityReplyHandlers, CONPTY_DA1_RESPONSE } =
        await import('../../renderer/src/components/terminal-pane/terminal-capability-replies')
      const originalWindow = globalThis.window
      vi.stubGlobal('navigator', { userAgent: 'Windows' })
      let output: ((event: { id: string; data: string }) => void) | undefined
      installIpcPtyWindow(originalWindow, {
        data: (callback) => {
          output = callback
        }
      })
      vi.mocked(window.api.pty.spawn).mockImplementation(async (request) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real handler returns the preload spawn contract.
        const answer = (await lanes.spawnWindow(request)) as Awaited<
          ReturnType<typeof window.api.pty.spawn>
        >
        output?.({ id: answer.id, data: '\x1b[c' })
        return answer
      })
      const transport = createIpcPtyTransport({
        cwd: WIN_PATH,
        shellOverride: 'wsl.exe',
        worktreeId: launchWorkspaceId(workspace),
        bufferInputUntilConnect: true
      })
      const terminal = new Terminal({ allowProposedApi: true })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every field read by the real compatibility refresh.
      const paneSession = {
        transport,
        pane: { terminal, id: 1 },
        deps: {
          worktreeId: launchWorkspaceId(workspace),
          tabId: 't',
          cwd: '\\\\wsl$\\Stale\\src',
          paneTransportsRef: { current: new Map([[1, transport]]) },
          isVisibleRef: { current: false }
        },
        transportStreamGeneration: 0,
        createProcessExitState: () => ({ detector: { observe: vi.fn() } }),
        reportRemoteRendererSerializerReady: vi.fn(),
        syncHiddenRendererPtyDelivery: vi.fn(),
        dataCallback: (chunk: string) => {
          expect(paneSession.isNativeWindowsConpty).toBe(true)
          terminal.write(chunk)
        },
        cacheKey: 't:p',
        executionHostId: 'local',
        isNativeWindowsConpty: false
      } as unknown as Parameters<typeof refreshPaneProcessCapabilities>[0]
      bindCaptureTransportOutputCallbacks(paneSession)
      installPaneAgentIdentity(paneSession)
      const replies = installTerminalCapabilityReplyHandlers({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: headless and renderer terminals share the parser/options contract used here.
        terminal: terminal as never,
        parser: terminal.parser,
        isReplaying: () => false,
        sendInput: (reply) => transport.sendInputImmediate(reply),
        da1Response: () => (paneSession.isNativeWindowsConpty ? CONPTY_DA1_RESPONSE : undefined)
      })
      vi.mocked(window.api.pty.writeAccepted).mockImplementation(async () => {
        expect(paneSession.isNativeWindowsConpty).toBe(true)
        return true
      })
      const earlyInput = transport.sendInputAccepted?.('before connect', 'driving')
      try {
        const starting = transport.connect({
          url: '',
          callbacks: paneSession.captureTransportOutputCallbacks(() => {}, {}).callbacks
        })
        await entered.promise
        projects.splice(0, 1, {
          id: 'project-1',
          sourceRepoIds: ['repo-1'],
          localWindowsRuntimePreference: { kind: 'windows-host' }
        })
        recovery.resolve(true)
        await starting
        expect(await earlyInput).toBe(true)
        await new Promise<void>((resolve) => terminal.write('', resolve))
        expect(paneSession.isForegroundTrackingAllowed('observed-native')).toBe(true)
        expect(paneSession.shouldProtectNativeWindowsSynchronizedOutput).toBe(true)
        expect(paneSession.shouldApplyNativeWindowsRewriteRefresh).toBe(true)
        expect(terminal.options.windowsPty).toMatchObject({ backend: 'conpty' })
        expect(terminal.options.vtExtensions.kittyKeyboard).toBe(false)
        expect(window.api.pty.write).toHaveBeenCalledWith(
          'observed-native',
          CONPTY_DA1_RESPONSE,
          'query-reply'
        )
        expect(window.api.pty.writeAccepted).toHaveBeenCalledWith(
          'observed-native',
          'before connect',
          'driving'
        )
        const actualShell = spawn.mock.calls[0][0].shellOverride
        expect(actualShell?.toLowerCase()).toContain('cmd.exe')
        expect(
          await suite.handlers.get('pty:listSessions')!(null, { connectionId: null })
        ).toMatchObject([
          {
            id: 'observed-native',
            shellPath: actualShell,
            wslDistro: null,
            incarnationId: '5b3b5ff4-23b1-4000-8000-000000000001'
          }
        ])
        useAppStore.setState({ ptyIdsByTabId: { t: ['observed-native'] } })
        const state = useAppStore.getState()
        const observedShell = readTerminalTabShell(state, { id: 't', shellOverride: 'wsl.exe' })
        expect(observedShell).toBe(actualShell)
        expect(ShellIcon({ shell: observedShell }).type).toBe(ShellIcon({ shell: 'cmd.exe' }).type)
        expect(
          resolveTerminalInputHostPlatform({
            clientPlatform: 'win32',
            state,
            worktreeId: launchWorkspaceId(workspace),
            transport
          })
        ).toBe('win32')
        expect(transport.getLocalSessionMetadata?.()?.shellOverride).toBe(actualShell)
        expect(
          resolveTerminalPasteRuntime({ platform: 'win32', ptyId: transport.getPtyId(), transport })
            .kind
        ).toBe('local')
        expect(
          isLocalWindowsConptyPaneForCtrlArrow({
            isWindows: true,
            userAgent: 'Windows',
            state,
            worktreeId: launchWorkspaceId(workspace),
            tabId: 't',
            paneId: 1,
            paneCwd: new Map(),
            fallbackCwd: WIN_PATH,
            transport
          })
        ).toBe(true)
        expect(
          resolveDashboardCardTerminalInput(state, {
            ptyId: 'observed-native',
            worktreeId: launchWorkspaceId(workspace),
            paneKey: 't:p',
            cwd: WIN_PATH,
            shellOverride: 'wsl.exe',
            launchAgent: null,
            clientPlatform: 'win32',
            userAgent: 'Windows',
            osRelease: '10.0.26100'
          })
        ).toMatchObject({ hostPlatform: 'win32', localWindowsConpty: true })
      } finally {
        transport.detach()
        paneSession.paneForegroundAgentTracker.dispose()
        replies.dispose()
        terminal.dispose()
        restorePtySpecWindow(originalWindow)
        vi.unstubAllGlobals()
      }
    })

    // A caller-named session the host no longer has is created too, so it falls back like a fresh one.
    it.each([
      { name: 'a fresh start', window: {}, host: {} },
      {
        name: 'a dead caller-named session',
        window: { sessionId: 'pty-gone-window' },
        host: { sessionId: 'pty-gone-host' }
      }
    ])('a deleted folder, $name: both lanes start in the workspace root and say so', async (c) => {
      setMainPlatform('darwin')
      const missing = `${POSIX_PATH}/deleted`
      statSyncMock.mockImplementation((target: string) => {
        if (target === missing) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return { isDirectory: () => true, mode: 0o755 }
      })
      const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
      const facts = await spawnBoth(
        lanes,
        POSIX_REPO,
        { cwd: missing, ...c.window },
        { cwd: missing, ...c.host }
      )

      const fallback = { kind: 'worktree', cwd: POSIX_PATH }
      expect(facts.window).toMatchObject({
        cwd: POSIX_PATH,
        result: { startupCwdFallback: fallback }
      })
      expect(facts.host).toMatchObject({
        cwd: POSIX_PATH,
        created: { startupCwdFallback: fallback }
      })
      expect(lanes.reveal).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.not.objectContaining({ startupCwdFallback: expect.anything() })
      )
    })

    it.each([
      {
        name: 'a folder containing a WSL-project repo',
        workspace: {
          kind: 'folder',
          path: String.raw`C:\Users\alice`,
          repoPath: WIN_PATH,
          projectRuntime: WSL_UBUNTU
        } satisfies LaunchWorkspace
      },
      {
        name: 'a \\wsl$ repo with no saved runtime',
        workspace: { kind: 'repo', path: WSL_PATH } satisfies LaunchWorkspace
      }
    ])('Windows plain terminal, $name: both callers use the workspace runtime', async (c) => {
      setMainPlatform('win32')
      const lanes = startParityLanes(suite, { workspace: c.workspace })
      const facts = await spawnBoth(lanes, c.workspace, { projectRuntime: WSL_PROJECT_SENT })

      expect(facts.window).toMatchObject({
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })
      expect(facts.host).toMatchObject({
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })
    })

    it("an older window's sent runtime cannot override the host-owned workspace", async () => {
      setMainPlatform('win32')
      const workspace = {
        kind: 'repo',
        path: WIN_PATH,
        projectRuntime: { kind: 'windows-host' }
      } as const
      const lanes = startParityLanes(suite, { workspace })
      const facts = await spawnBoth(lanes, workspace, { projectRuntime: WSL_PROJECT_SENT })
      expect(facts.window).toMatchObject({
        shellOverride: 'powershell.exe',
        terminalWindowsWslDistro: null
      })
      expect(facts.host).toMatchObject({
        shellOverride: 'powershell.exe',
        terminalWindowsWslDistro: null
      })
    })

    it.each([true, false])(
      'fresh setup keeps its action runtime (project target: %s) before any tab is saved',
      async (useProject) => {
        setMainPlatform('win32')
        const lanes = startParityLanes(suite, { workspace: { kind: 'repo', path: WIN_PATH } })
        await lanes.spawnWindow({
          cols: 80,
          rows: 24,
          worktreeId: 'ephemeral-setup-terminal:install',
          cwd: WIN_PATH,
          ...(useProject ? { projectRuntime: WSL_PROJECT_SENT } : {})
        })
        expect(await providerFacts(lanes.provider)).toMatchObject({
          shellOverride: useProject ? 'wsl.exe' : 'powershell.exe',
          terminalWindowsWslDistro: useProject ? 'Ubuntu' : null
        })
      }
    )

    it('a restored host-shell tab keeps its saved bypass with no live PTY binding', async () => {
      setMainPlatform('win32')
      const workspace = { kind: 'repo', path: WIN_PATH, projectRuntime: WSL_UBUNTU } as const
      const worktreeId = launchWorkspaceId(workspace)
      const lanes = startParityLanes(suite, { workspace })
      lanes.store.getWorkspaceSession().tabsByWorktree[worktreeId] = [
        {
          id: HOST_TAB_ID,
          worktreeId,
          ptyId: null,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0,
          forceHostRuntime: true
        }
      ]
      await lanes.spawnWindow({ cols: 80, rows: 24, worktreeId, tabId: HOST_TAB_ID, cwd: WIN_PATH })
      expect(await providerFacts(lanes.provider)).toMatchObject({
        shellOverride: 'powershell.exe',
        terminalWindowsWslDistro: null
      })
    })

    it.each([false, true])(
      'canonical local project pin and project array order govern spawn and mobile refusal (repo first: %s)',
      async (repoFirst) => {
        setMainPlatform('win32')
        const workspace = { kind: 'repo', path: WIN_PATH } as const
        const pinned = {
          id: 'pinned',
          sourceRepoIds: [],
          localWindowsRuntimePreference: { kind: 'windows-host' }
        } as const
        const matching = {
          id: 'matches',
          sourceRepoIds: ['repo-1'],
          localWindowsRuntimePreference: WSL_UBUNTU
        }
        const lanes = startParityLanes(suite, {
          workspace,
          projects: repoFirst
            ? [matching, { ...pinned, sourceRepoIds: [] }]
            : [{ ...pinned, sourceRepoIds: [] }, matching],
          legacyMeta: { projectId: 'matches', hostId: 'ssh:other' },
          localMeta: { projectId: 'pinned', hostId: 'local' }
        })
        const id = launchWorkspaceId(workspace)
        expect(resolveLocalTerminalRuntime(lanes.store, id)).toMatchObject({
          status: 'resolved',
          runtime: { projectId: 'pinned', kind: repoFirst ? 'wsl' : 'windows-host' }
        })
        const shellOverride = repoFirst ? 'wsl.exe' : 'cmd.exe'
        expect(() =>
          assertMobileTerminalShellSupported(
            lanes.store,
            {
              id,
              path: WIN_PATH,
              connectionId: null,
              repo: null,
              folderWorkspace: null
            },
            shellOverride,
            undefined
          )
        ).not.toThrow()
        const facts = await spawnBoth(
          lanes,
          workspace,
          { shellOverride, cwd: 'C:\\elsewhere' },
          { shellOverride, cwd: 'C:\\elsewhere' }
        )
        for (const fact of Object.values(facts)) {
          expect(fact).toMatchObject({
            shellOverride,
            terminalWindowsWslDistro: repoFirst ? 'Ubuntu' : null
          })
        }
      }
    )

    // One resolution reads it for both lanes. Only an SSH-launched orcad has this env, and it has no
    // window (no pty:spawn), so the window lane never meets it in practice.
    it('Windows managed SSH host: both lanes open the OpenSSH login shell', async () => {
      setMainPlatform('win32')
      vi.stubEnv('ORCA_ORCAD_MANAGED_ACTIVATION_ROOT', '/activation')
      vi.mocked(readOpenSshDefaultShell).mockReturnValue(LOGIN_SHELL)
      const workspace = { kind: 'repo', path: WIN_PATH } satisfies LaunchWorkspace
      const lanes = startParityLanes(suite, { workspace })
      const facts = await spawnBoth(lanes, workspace, {})

      expect(facts.window).toMatchObject({ shellOverride: LOGIN_SHELL })
      expect(facts.host).toMatchObject({ shellOverride: LOGIN_SHELL })
    })
  })
}
