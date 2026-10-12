import type { RuntimeSessionGraphLifecycle } from './session-graph/session-graph-lifecycle'
import { OrcaRuntimeWithStopExactTerminalsForWorktree } from './orca-runtime-stop-exact-terminals-for-worktree'

export abstract class OrcaRuntimeWithHasTerminalsForWorktree extends OrcaRuntimeWithStopExactTerminalsForWorktree {
  hasTerminalsForWorktree(
    ...args: Parameters<RuntimeSessionGraphLifecycle['hasTerminalsForWorktree']>
  ): ReturnType<RuntimeSessionGraphLifecycle['hasTerminalsForWorktree']> {
    return this.runtimeSessionGraphLifecycle.hasTerminalsForWorktree(...args)
  }

  markRendererReloading(
    ...args: Parameters<RuntimeSessionGraphLifecycle['markRendererReloading']>
  ): ReturnType<RuntimeSessionGraphLifecycle['markRendererReloading']> {
    return this.runtimeSessionGraphLifecycle.markRendererReloading(...args)
  }

  protected beginGraphReload(
    ...args: Parameters<RuntimeSessionGraphLifecycle['beginGraphReload']>
  ): ReturnType<RuntimeSessionGraphLifecycle['beginGraphReload']> {
    return this.runtimeSessionGraphLifecycle.beginGraphReload(...args)
  }

  markRendererReloadCancelled(
    ...args: Parameters<RuntimeSessionGraphLifecycle['markRendererReloadCancelled']>
  ): ReturnType<RuntimeSessionGraphLifecycle['markRendererReloadCancelled']> {
    return this.runtimeSessionGraphLifecycle.markRendererReloadCancelled(...args)
  }

  markGraphReady(
    ...args: Parameters<RuntimeSessionGraphLifecycle['markGraphReady']>
  ): ReturnType<RuntimeSessionGraphLifecycle['markGraphReady']> {
    return this.runtimeSessionGraphLifecycle.markGraphReady(...args)
  }

  markGraphReloadFailed(
    ...args: Parameters<RuntimeSessionGraphLifecycle['markGraphReloadFailed']>
  ): ReturnType<RuntimeSessionGraphLifecycle['markGraphReloadFailed']> {
    return this.runtimeSessionGraphLifecycle.markGraphReloadFailed(...args)
  }

  markGraphUnavailable(
    ...args: Parameters<RuntimeSessionGraphLifecycle['markGraphUnavailable']>
  ): ReturnType<RuntimeSessionGraphLifecycle['markGraphUnavailable']> {
    return this.runtimeSessionGraphLifecycle.markGraphUnavailable(...args)
  }

  protected handleGraphReloadTimeout(
    ...args: Parameters<RuntimeSessionGraphLifecycle['handleGraphReloadTimeout']>
  ): ReturnType<RuntimeSessionGraphLifecycle['handleGraphReloadTimeout']> {
    return this.runtimeSessionGraphLifecycle.handleGraphReloadTimeout(...args)
  }
}
