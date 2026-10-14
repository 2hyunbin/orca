import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { findOrcadMigrationImportReceipt } from './orcad-catalog-receipt-ledger'
import { installOrcadMigrationReceivedBlobs } from './orcad-migration-blob-installers'
import { OrcadTerminalRestoreHintStore } from './orcad-terminal-restore-hint-store'

type OrcadMigrationBlobInstallRuntime = Pick<StoreRuntimeState, 'state' | 'orcadMigrationBlobRoot'>

const orcadMigrationBlobInstallContext = Symbol('OrcadMigrationBlobInstallPersistence')
type OrcadMigrationBlobInstallContext = {
  runtime: OrcadMigrationBlobInstallRuntime
  terminalRestoreHints: OrcadTerminalRestoreHintStore
}

/** The destination's committed migration blobs, installed into host-local state and consumed. */
export class OrcadMigrationBlobInstallPersistence {
  readonly [orcadMigrationBlobInstallContext]: OrcadMigrationBlobInstallContext

  constructor(runtime: OrcadMigrationBlobInstallRuntime) {
    this[orcadMigrationBlobInstallContext] = {
      runtime,
      terminalRestoreHints: new OrcadTerminalRestoreHintStore(runtime.orcadMigrationBlobRoot)
    }
  }

  /**
   * Run only once the commit is durable: installing first and then losing the commit would leave
   * live hints for a catalog this host never received. A no-op before commit and on repeats.
   */
  installOrcadMigrationReceivedBlobs(
    manifest: OrcadMigrationManifest,
    options: { now?: () => Date } = {}
  ): void {
    const context = this[orcadMigrationBlobInstallContext]
    const receipt = findOrcadMigrationImportReceipt(context.runtime.state, manifest)
    if (receipt?.manifestSha256 !== manifest.manifestSha256) {
      return
    }
    installOrcadMigrationReceivedBlobs({
      migration: manifest,
      root: context.runtime.orcadMigrationBlobRoot,
      terminalRestoreHints: context.terminalRestoreHints,
      now: (options.now ?? (() => new Date()))().getTime()
    })
  }

  /** The moved pane's last folder, once; later creates of the same pane get null. */
  takeOrcadMigrationTerminalRestoreHint(
    paneKey: string,
    options: { now?: () => Date } = {}
  ): string | null {
    return this[orcadMigrationBlobInstallContext].terminalRestoreHints.take(
      paneKey,
      (options.now ?? (() => new Date()))().getTime()
    )
  }
}
