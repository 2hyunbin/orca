import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import type { PtyControllerInventory } from '../runtime-pty-controller-contract'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { SessionTabsInventoryPublication } from './session-tabs-inventory-publication'

export type RuntimeSessionTabsInventoryHost = {
  getValidatedExplicitWorktreeIdSelector(selector: string): string | null
  resolveWorktreeSelector(selector: string): Promise<{ id: string }>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId?: string,
    options?: { allowAttachedWindow?: boolean; onlyRuntimeOwnedTerminals?: boolean }
  ): Set<string>
  refreshMobileSessionPtyRecords(worktreeId?: string): Promise<Set<string> | null>
  refreshMobileSessionPtyInventory(): Promise<PtyControllerInventory | null>
  restoreLivePairedRendererSessionOwnedMobileTerminals(worktreeId: string | null): void
  getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult
  getKnownWorkspaceSessionWorktreeIds(): Iterable<string>
  getMobileSnapshots(): Iterable<RuntimeMobileSessionTabsSnapshot>
  projectMobileSessionTabsForClient(
    snapshot: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult
  toMobileSessionTabsResult(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsResult
  getChangeSequence(): number
  listKnownExecutionHostIds(additionalHostIds: Iterable<ExecutionHostId>): Set<ExecutionHostId>
  publication: SessionTabsInventoryPublication
  listAllMobileSessionTabsWithChangeSequence: RuntimeSessionTabsInventory['listAllMobileSessionTabsWithChangeSequence']
  collectAllMobileSessionTabs: RuntimeSessionTabsInventory['collectAllMobileSessionTabs']
  listAllMobileSessionTabsInventoryWithChangeSequence: RuntimeSessionTabsInventory['listAllMobileSessionTabsInventoryWithChangeSequence']
  assertSessionTabsInventoryRequestActive: RuntimeSessionTabsInventory['assertSessionTabsInventoryRequestActive']
  getAuthoritativeSessionTabsInventoryEpoch: RuntimeSessionTabsInventory['getAuthoritativeSessionTabsInventoryEpoch']
  settleSessionTabsInventory: RuntimeSessionTabsInventory['settleSessionTabsInventory']
  waitForSessionTabsInventoryPublication: RuntimeSessionTabsInventory['waitForSessionTabsInventoryPublication']
  isCompleteSessionTabsPtyCensus: RuntimeSessionTabsInventory['isCompleteSessionTabsPtyCensus']
}

export class RuntimeSessionTabsInventory {
  constructor(private readonly host: RuntimeSessionTabsInventoryHost) {}

  async listMobileSessionTabs(
    worktreeSelector: string,
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult> {
    const explicitWorktreeId = this.host.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    if (explicitWorktreeId) {
      this.host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
      this.host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId)
      await this.host.refreshMobileSessionPtyRecords(explicitWorktreeId)
      this.host.restoreLivePairedRendererSessionOwnedMobileTerminals(explicitWorktreeId)
      return this.host.getMobileSessionTabsForWorktree(explicitWorktreeId, clientNavigationId)
    }
    const worktree = await this.host.resolveWorktreeSelector(worktreeSelector)
    this.host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id)
    await this.host.refreshMobileSessionPtyRecords()
    this.host.restoreLivePairedRendererSessionOwnedMobileTerminals(worktree.id)
    return this.host.getMobileSessionTabsForWorktree(worktree.id, clientNavigationId)
  }

  async listAllMobileSessionTabs(
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult[]> {
    return (await this.host.listAllMobileSessionTabsWithChangeSequence(clientNavigationId))
      .snapshots
  }

  async listAllMobileSessionTabsWithChangeSequence(clientNavigationId?: string): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    changeSequence: number
  }> {
    const inventory = await this.host.collectAllMobileSessionTabs(clientNavigationId)
    return { snapshots: inventory.snapshots, changeSequence: inventory.changeSequence }
  }

  async collectAllMobileSessionTabs(clientNavigationId?: string): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    ptyInventory: PtyControllerInventory | null
    changeSequence: number
  }> {
    for (const worktreeId of this.host.getKnownWorkspaceSessionWorktreeIds()) {
      this.host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    const ptyInventory = await this.host.refreshMobileSessionPtyInventory()
    this.host.restoreLivePairedRendererSessionOwnedMobileTerminals(null)
    const snapshots = [...this.host.getMobileSnapshots()].map((snapshot) =>
      this.host.projectMobileSessionTabsForClient(
        this.host.toMobileSessionTabsResult(snapshot),
        clientNavigationId
      )
    )
    return { snapshots, ptyInventory, changeSequence: this.host.getChangeSequence() }
  }

  async listAllMobileSessionTabsInventory(
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{ snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: true }> {
    const { snapshots, authoritative } =
      await this.host.listAllMobileSessionTabsInventoryWithChangeSequence(
        clientNavigationId,
        signal
      )
    return { snapshots, ...(authoritative ? { authoritative } : {}) }
  }

  async listAllMobileSessionTabsInventoryWithChangeSequence(
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    authoritative?: true
    changeSequence: number
  }> {
    this.host.assertSessionTabsInventoryRequestActive(signal)
    const primedPublicationEpoch = this.host.getAuthoritativeSessionTabsInventoryEpoch()
    const primed = await this.host.collectAllMobileSessionTabs(clientNavigationId)
    this.host.assertSessionTabsInventoryRequestActive(signal)
    if (
      primedPublicationEpoch !== null &&
      this.host.getAuthoritativeSessionTabsInventoryEpoch() === primedPublicationEpoch
    ) {
      return await this.host.settleSessionTabsInventory(primed, clientNavigationId, signal)
    }
    while (true) {
      const publicationEpoch = this.host.getAuthoritativeSessionTabsInventoryEpoch()
      if (publicationEpoch === null) {
        await this.host.waitForSessionTabsInventoryPublication(signal)
        continue
      }
      const inventory = await this.host.collectAllMobileSessionTabs(clientNavigationId)
      this.host.assertSessionTabsInventoryRequestActive(signal)
      if (this.host.getAuthoritativeSessionTabsInventoryEpoch() === publicationEpoch) {
        return await this.host.settleSessionTabsInventory(inventory, clientNavigationId, signal)
      }
    }
  }

  async settleSessionTabsInventory(
    inventory: {
      snapshots: RuntimeMobileSessionTabsResult[]
      ptyInventory: PtyControllerInventory | null
      changeSequence: number
    },
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    authoritative?: true
    changeSequence: number
  }> {
    if (this.host.isCompleteSessionTabsPtyCensus(inventory.ptyInventory)) {
      return {
        snapshots: inventory.snapshots,
        authoritative: true,
        changeSequence: inventory.changeSequence
      }
    }
    const retried = await this.host.collectAllMobileSessionTabs(clientNavigationId)
    this.host.assertSessionTabsInventoryRequestActive(signal)
    return { snapshots: retried.snapshots, changeSequence: retried.changeSequence }
  }

  supportsAuthoritativeSessionTabsInventory(): boolean {
    return process.env.ORCA_E2E_DISABLE_AUTHORITATIVE_SESSION_TABS_INVENTORY !== '1'
  }

  assertSessionTabsInventoryRequestActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('client_disconnected')
    }
  }

  isCompleteSessionTabsPtyCensus(inventory: PtyControllerInventory | null): boolean {
    if (!inventory) {
      return false
    }
    const knownHostIds = this.host.listKnownExecutionHostIds(inventory.queriedHostIds)
    return ![...knownHostIds].some((hostId) => {
      const parsed = parseExecutionHostId(hostId)
      return parsed?.kind !== 'runtime' && !inventory.queriedHostIds.has(hostId)
    })
  }

  waitForSessionTabsInventoryPublication(signal?: AbortSignal): Promise<void> {
    return this.host.publication.waitForSessionTabsInventoryPublication(signal)
  }

  getAuthoritativeSessionTabsInventoryEpoch(): number | null {
    return this.host.publication.getAuthoritativeSessionTabsInventoryEpoch()
  }

  markSessionTabsInventoryPublished(): void {
    this.host.publication.markSessionTabsInventoryPublished()
  }
}
