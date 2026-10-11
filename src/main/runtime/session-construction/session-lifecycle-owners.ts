import {
  createRuntimeSessionTabsInventory,
  createRuntimeTerminalSurfaceRetirements,
  createRuntimeStructuredSessionTabs,
  createRuntimeMobileSessionPreservation,
  createRuntimeMobileSessionHydration
} from './session-tab-owners'
import {
  createRuntimeMobileSessionReconciliation,
  createRuntimeRendererSessionTerminalRescue,
  createRuntimeSessionGraphLifecycle,
  createRuntimeSessionWindowGraph
} from './session-graph-owners'
import {
  createRuntimeHeadlessTerminalTabClose,
  createRuntimeExplicitTerminalCloseStops,
  createRuntimeFloatingSessionLiveness,
  createRuntimeSessionGraphPromotion,
  createRuntimeHeadlessSessionTabCommands
} from './session-close-owners'
import { RuntimeSessionLifecycleState } from './session-lifecycle-state'
import type { SessionLifecyclePorts } from './session-lifecycle-ports'

export abstract class RuntimeSessionLifecycleOwners extends RuntimeSessionLifecycleState {
  protected abstract readonly sessionPorts: SessionLifecyclePorts

  protected readonly runtimeSessionTabsInventory = createRuntimeSessionTabsInventory(
    () => this.sessionPorts
  )

  protected readonly runtimeTerminalSurfaceRetirements = createRuntimeTerminalSurfaceRetirements(
    () => this.sessionPorts
  )

  protected readonly runtimeStructuredSessionTabs = createRuntimeStructuredSessionTabs(
    () => this.sessionPorts
  )

  protected get structuredAgentSessionInventoryUnverifiable(): boolean {
    return this.runtimeStructuredSessionTabs.inventoryUnverifiable
  }

  protected readonly runtimeMobileSessionPreservation = createRuntimeMobileSessionPreservation(
    () => this.sessionPorts
  )

  protected readonly runtimeMobileSessionHydration = createRuntimeMobileSessionHydration(
    () => this.sessionPorts
  )

  protected readonly runtimeMobileSessionReconciliation = createRuntimeMobileSessionReconciliation(
    () => this.sessionPorts
  )

  protected readonly runtimeRendererSessionTerminalRescue =
    createRuntimeRendererSessionTerminalRescue(() => this.sessionPorts)

  protected readonly runtimeSessionGraphLifecycle = createRuntimeSessionGraphLifecycle(
    () => this.sessionPorts
  )

  protected readonly runtimeSessionWindowGraph = createRuntimeSessionWindowGraph(
    () => this.sessionPorts
  )

  protected readonly runtimeHeadlessTerminalTabClose = createRuntimeHeadlessTerminalTabClose(
    () => this.sessionPorts
  )

  protected readonly runtimeExplicitTerminalCloseStops = createRuntimeExplicitTerminalCloseStops(
    () => this.sessionPorts
  )

  protected readonly runtimeFloatingSessionLiveness = createRuntimeFloatingSessionLiveness(
    () => this.sessionPorts
  )

  protected readonly runtimeSessionGraphPromotion = createRuntimeSessionGraphPromotion(
    () => this.sessionPorts
  )

  protected readonly headlessSessionTabCommands = createRuntimeHeadlessSessionTabCommands(
    () => this.sessionPorts
  )
}
