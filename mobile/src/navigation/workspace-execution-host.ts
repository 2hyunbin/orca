import { createContext, useContext } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RouterHref } from './route-href'

// Provided by `WorkspaceRoute`; apart from it so readers need not load expo-router.
export const WorkspaceExecutionHostContext = createContext<ExecutionHostId | undefined>(undefined)

export function useWorkspaceExecutionHost(): ExecutionHostId | undefined {
  return useContext(WorkspaceExecutionHostContext)
}

/** Whether this workspace's host can open a desktop editor tab (Open in Session, New Note). */
export function useWorkspaceHostOpensEditorTabs(): boolean {
  // Why the route, not a host signal: no host advertises a desktop window, and a server workspace's calls go to its own host.
  return useWorkspaceExecutionHost() === undefined
}

/** The params a push into another screen of this workspace carries, so it stays on the server. */
export function workspaceRouteParams(executionHost: ExecutionHostId | undefined): {
  executionHost?: ExecutionHostId
} {
  return executionHost ? { executionHost } : {}
}

/** The same, for a pushed href string. */
export function workspaceRouteHref(
  href: string,
  executionHost: ExecutionHostId | undefined
): string {
  if (!executionHost) {
    return href
  }
  return `${href}${href.includes('?') ? '&' : '?'}executionHost=${encodeURIComponent(executionHost)}`
}

/** The same, for any router target. */
export function workspaceHref(href: RouterHref, executionHost: ExecutionHostId): RouterHref {
  return typeof href === 'string'
    ? workspaceRouteHref(href, executionHost)
    : { ...href, params: { ...href.params, executionHost } }
}
