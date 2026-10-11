import { mergeStructuredAgentSessionTabGroups } from './session-tabs/structured-session-tab-groups'
import type { RuntimeMobileSessionPreservation } from './session-tabs/mobile-session-preservation'
import { OrcaRuntimeWithSyncMobileSessionTabs } from './orca-runtime-sync-mobile-session-tabs'

export class OrcaRuntimeWithMergePreservedHeadlessMobileSessionTabs extends OrcaRuntimeWithSyncMobileSessionTabs {
  protected mergePreservedHeadlessMobileSessionTabs(
    ...args: Parameters<RuntimeMobileSessionPreservation['mergePreservedHeadlessMobileSessionTabs']>
  ): ReturnType<RuntimeMobileSessionPreservation['mergePreservedHeadlessMobileSessionTabs']> {
    return this.runtimeMobileSessionPreservation.mergePreservedHeadlessMobileSessionTabs(...args)
  }

  protected releaseRuntimeSessionOwnershipForRendererRetiredTabs(
    ...args: Parameters<
      RuntimeMobileSessionPreservation['releaseRuntimeSessionOwnershipForRendererRetiredTabs']
    >
  ): ReturnType<
    RuntimeMobileSessionPreservation['releaseRuntimeSessionOwnershipForRendererRetiredTabs']
  > {
    return this.runtimeMobileSessionPreservation.releaseRuntimeSessionOwnershipForRendererRetiredTabs(
      ...args
    )
  }

  protected buildPreservedHeadlessMobileSessionSnapshot(
    ...args: Parameters<
      RuntimeMobileSessionPreservation['buildPreservedHeadlessMobileSessionSnapshot']
    >
  ): ReturnType<RuntimeMobileSessionPreservation['buildPreservedHeadlessMobileSessionSnapshot']> {
    return this.runtimeMobileSessionPreservation.buildPreservedHeadlessMobileSessionSnapshot(
      ...args
    )
  }

  protected mergeStructuredAgentSessionTabGroups(
    ...args: Parameters<typeof mergeStructuredAgentSessionTabGroups>
  ): ReturnType<typeof mergeStructuredAgentSessionTabGroups> {
    return mergeStructuredAgentSessionTabGroups(...args)
  }
}
