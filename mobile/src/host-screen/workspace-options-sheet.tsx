import { useMemo } from 'react'
import { Pressable, Text, View } from 'react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import {
  WORKSPACE_VIEW_SECTION_LABELS,
  getShownWorkspaceViewSections
} from '../../../src/shared/workspace-view/workspace-view-options'
import { getHostContextLabel } from '../../../src/shared/worktree/host-context-labels'
import { WORKSPACE_VIEW_SHARED_NOTE } from '../worktree/workspace-list-picker-options'
import { resolveWorktreeHostId } from '../worktree/worktree-host-context-labels'
import { withServerHosts } from '../worktree/server-workspaces'
import { hostScreenStyles as styles } from './host-screen-styles'
import type { HostScreenController } from './use-host-screen-controller'
import {
  OptionRowList,
  WORKSPACE_OPTION_ROWS,
  type WorkspaceOptionHost
} from './workspace-option-rows'

/** Every host the list can show, this computer first; labelled as the rows label them. */
function useWorkspaceOptionHosts(controller: HostScreenController): WorkspaceOptionHost[] {
  const { displayWorktrees, state } = controller
  return useMemo(() => {
    const ids = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
    state.repoHostIdByRepoId.forEach((id) => ids.add(id))
    state.serverWorkspaces.hosts.forEach((host) => ids.add(host.hostId))
    displayWorktrees.forEach((row) => ids.add(resolveWorktreeHostId(row, state.repoHostIdByRepoId)))
    const hostLabelById = withServerHosts(
      state.hostLabelById,
      state.serverWorkspaces.hosts,
      (host) => host.label
    )
    return [...ids].map((id) => ({
      id,
      label: getHostContextLabel(id, { hostLabelById, hostPlatform: state.hostPlatform })
    }))
  }, [
    displayWorktrees,
    state.repoHostIdByRepoId,
    state.serverWorkspaces.hosts,
    state.hostLabelById,
    state.hostPlatform
  ])
}

/** The desktop sidebar's Workspace options, rendered from the shared option list. */
export function WorkspaceOptionsSheet({ controller }: { controller: HostScreenController }) {
  const { state } = controller
  return (
    <BottomDrawer
      visible={state.showWorkspaceOptions}
      onClose={() => state.setShowWorkspaceOptions(false)}
    >
      <WorkspaceOptionsContent controller={controller} />
    </BottomDrawer>
  )
}

// Its own component so the host list is built only while the sheet is open.
function WorkspaceOptionsContent({ controller }: { controller: HostScreenController }) {
  const { settings, state } = controller
  const hosts = useWorkspaceOptionHosts(controller)
  const sections = getShownWorkspaceViewSections({
    groupBy: state.view.groupBy,
    hideSleepingWorkspaces: state.view.filters.hideSleepingWorkspaces,
    hideWorkspacesFromOtherDevices: state.view.filters.hideWorkspacesFromOtherDevices,
    newCardStyle: state.cardSettings.newCardStyle,
    hasRemoteHosts: hosts.some((host) => parseExecutionHostId(host.id)?.kind !== 'local'),
    projectCount: controller.sectionsResult.uniqueRepos.length,
    // Why the host's say-so: a host that keeps the filter to itself cannot apply the phone's value.
    mayHaveServerHosts:
      state.view.sharesOtherClientFilter && state.serverWorkspaces.hosts.length > 0
  })

  return (
    <>
      <View style={styles.filterModalHeader}>
        <View style={styles.filterModalHeading}>
          <Text style={styles.filterModalTitle}>Workspace options</Text>
          <Text style={styles.filterModalSubtitle}>{WORKSPACE_VIEW_SHARED_NOTE}</Text>
        </View>
        {controller.activeFilterCount > 0 && (
          <Pressable onPress={settings.clearFilters}>
            <Text style={styles.clearFiltersText}>Clear filters</Text>
          </Pressable>
        )}
      </View>

      {sections.map(({ section, options }) => {
        const sectionLabel = WORKSPACE_VIEW_SECTION_LABELS[section]
        return (
          <View key={section}>
            {sectionLabel && <Text style={styles.filterSectionLabel}>{sectionLabel}</Text>}
            {section === 'filters' ? (
              <View style={styles.filterGroup}>
                <OptionRowList>
                  {options.map((option) => {
                    const Rows = WORKSPACE_OPTION_ROWS[option.key]
                    return (
                      <Rows
                        key={option.key}
                        controller={controller}
                        hosts={hosts}
                        label={option.label}
                      />
                    )
                  })}
                </OptionRowList>
              </View>
            ) : (
              options.map((option) => {
                const Rows = WORKSPACE_OPTION_ROWS[option.key]
                return (
                  <View key={option.key} testID={`workspace-option-${option.key}`}>
                    {option.label !== sectionLabel && (
                      <Text style={styles.optionHeading}>{option.label}</Text>
                    )}
                    <View style={styles.filterGroup}>
                      <Rows controller={controller} hosts={hosts} label={option.label} />
                    </View>
                  </View>
                )
              })
            )}
          </View>
        )
      })}
    </>
  )
}
