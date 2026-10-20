// Which workspaces a paired server's main takes layout intents for now: those its frames draw in
// this window (server-layout-frames.ts). A leaf, so the store-free sender can ask without the store.

/** A workspace a server's frames draw, as `layout.apply` reaches that server's main. */
export type ServerLayoutApplyRoute = {
  environmentId: string
  /** A desktop tab id as the server names it; null when its frames hold no such tab. */
  serverTabId: (desktopTabId: string) => string | null
  /** A server tab id under desktop ids. */
  desktopTabId: (serverTabId: string) => string
  /** Draws the workspace from the server's frames again, over whatever the window drew. */
  redraw: () => void
}

type RouteProvider = (worktreeId: string) => ServerLayoutApplyRoute | null

const providers = new Map<string, RouteProvider>()

export function provideServerLayoutApplyRoutes(
  environmentId: string,
  provider: RouteProvider
): () => void {
  providers.set(environmentId, provider)
  return () => {
    if (providers.get(environmentId) === provider) {
      providers.delete(environmentId)
    }
  }
}

/** Null unless the server's frames draw the workspace now. */
export function serverLayoutApplyRoute(
  environmentId: string,
  worktreeId: string
): ServerLayoutApplyRoute | null {
  return providers.get(environmentId)?.(worktreeId) ?? null
}
