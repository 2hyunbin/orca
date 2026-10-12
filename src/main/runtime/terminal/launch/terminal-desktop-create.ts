import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import type { TerminalCreateOptions, TerminalHandleRecord } from '../../runtime-terminal-contracts'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalPresentation
} from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import { getRuntimeDesktopSurface } from '../../runtime-desktop-surface'
import { ownerSurfacing } from '../../orca-runtime-core'
import type { Worktree } from '../../../../shared/worktree/types'

export type DesktopTerminalLaunchHost = {
  resolveTerminalWorkspaceLaunchScope(): (
    selector: string,
    createdWorktree?: Worktree
  ) => Promise<TerminalWorkspaceLaunchScope>
  resolveAgentTerminalCreateOptions(): (
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ) => Promise<TerminalCreateOptions>
  resolveWorkspaceTerminalStartupCwd(): (
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ) => string | undefined
  getPtyExecutionHostMetadata(): (
    ptyId: string | null
  ) => Pick<RuntimeTerminalCreate, 'executionHostId' | 'hostPlatform' | 'incarnationId'>
  assertGraphReady(): () => void
  getAuthoritativeWindow(): BrowserWindow
  waitForTerminalHandle(): (tabId: string) => Promise<string>
  getHandles(): ReadonlyMap<string, TerminalHandleRecord>
}

export async function createDesktopTerminal(
  runtime: DesktopTerminalLaunchHost,
  worktreeSelector: string | undefined,
  opts: TerminalCreateOptions,
  presentation: RuntimeTerminalPresentation | undefined,
  rendererWindow: Electron.BrowserWindow | null,
  createdWorktree?: Worktree
): Promise<RuntimeTerminalCreate> {
  runtime.assertGraphReady()()
  const win = rendererWindow ?? runtime.getAuthoritativeWindow()
  const workspace = worktreeSelector
    ? await runtime.resolveTerminalWorkspaceLaunchScope()(worktreeSelector, createdWorktree)
    : null
  const launchOpts = workspace
    ? await runtime.resolveAgentTerminalCreateOptions()(workspace, opts)
    : opts
  // `resolveAgentTerminalCreateOptions` refuses an unapplicable shell, and it only runs with a
  // workspace; a worktree-less create has no execution host to apply one to either.
  if (!workspace && opts.shellOverride) {
    throw new Error(
      `--shell ${opts.shellOverride} needs a workspace, because the shell is resolved on the workspace's execution host. No terminal was created.`
    )
  }
  const worktreeId = workspace?.id
  const cwd = workspace
    ? runtime.resolveWorkspaceTerminalStartupCwd()(workspace, launchOpts.cwd)
    : launchOpts.cwd
  const requestId = randomUUID()
  const reply = await new Promise<{ tabId: string; title: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
      reject(new Error('Terminal creation timed out'))
    }, 10000)
    const handler = (
      event: IpcMainEvent,
      response: {
        requestId: string
        tabId?: string
        title?: string
        error?: string
      }
    ): void => {
      if (event.sender !== win.webContents || response.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
      if (response.error) {
        reject(new Error(response.error))
      } else {
        resolve({ tabId: response.tabId!, title: response.title ?? launchOpts.title ?? '' })
      }
    }
    getRuntimeDesktopSurface().onIpc('terminal:tabCreateReply', handler)
    win.webContents.send('terminal:requestTabCreate', {
      requestId,
      worktreeId,
      command: launchOpts.command,
      cwd,
      ...(launchOpts.env ? { env: launchOpts.env } : {}),
      ...(launchOpts.launchConfig ? { launchConfig: launchOpts.launchConfig } : {}),
      ...(launchOpts.resumeProviderSession
        ? { resumeProviderSession: launchOpts.resumeProviderSession }
        : {}),
      ...(launchOpts.launchToken ? { launchToken: launchOpts.launchToken } : {}),
      ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {}),
      ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
      startupCommandDelivery: launchOpts.startupCommandDelivery,
      ...(launchOpts.shellOverride ? { shellOverride: launchOpts.shellOverride } : {}),
      title: launchOpts.title,
      activate: presentation === 'focused',
      ...(presentation ? { presentation } : {}),
      ...ownerSurfacing(opts.surfaceOwner !== false)
    })
  })
  const handle = await runtime.waitForTerminalHandle()(reply.tabId)
  return {
    handle,
    tabId: reply.tabId,
    worktreeId: worktreeId ?? '',
    title: reply.title,
    ...runtime.getPtyExecutionHostMetadata()(runtime.getHandles().get(handle)?.ptyId ?? null),
    surface: 'visible'
  }
}
