import { Children, useState, type ComponentType, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { MobileSearchField } from '../components/MobileSearchField'
import { colors } from '../theme/mobile-theme'
import {
  WORKSPACE_AGENT_ACTIVITY_LAYOUT_CHOICES,
  WORKSPACE_CARD_DISPLAY_CHOICES,
  WORKSPACE_CARD_LAYOUT_CHOICES,
  WORKSPACE_CARD_PROPERTY_CHOICES,
  WORKSPACE_PROJECT_ORDER_CHOICES,
  WORKSPACE_VIEW_OPTIONS,
  getWorkspaceCardDisplayChoiceLabel,
  type WorkspaceViewChoice,
  type WorkspaceViewOptionKey
} from '../../../src/shared/workspace-view/workspace-view-options'
import {
  toggleAllVisibleHosts,
  toggleVisibleHostRow
} from '../../../src/shared/workspace-view/workspace-host-visibility'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { WorktreeCardProperty } from '../../../src/shared/ui-chrome-types'
import {
  WORKSPACE_GROUP_OPTIONS,
  WORKSPACE_SORT_OPTIONS
} from '../worktree/workspace-list-picker-options'
import { hostScreenStyles as styles } from './host-screen-styles'
import type { HostScreenController } from './use-host-screen-controller'

export type WorkspaceOptionHost = { id: ExecutionHostId; label: string }

export type WorkspaceOptionRowsProps = {
  controller: HostScreenController
  hosts: readonly WorkspaceOptionHost[]
}

function CheckRow(props: {
  label: string
  checked: boolean
  onPress: () => void
  detail?: string
  indent?: boolean
  leading?: ReactNode
}) {
  return (
    <Pressable
      style={[styles.filterRow, props.indent && styles.optionRowIndented]}
      onPress={props.onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.checked }}
      accessibilityLabel={props.label}
    >
      {props.leading}
      <View style={styles.optionRowLabel}>
        <Text style={styles.filterRowText} numberOfLines={1}>
          {props.label}
        </Text>
        {props.detail ? (
          <Text style={styles.optionRowDetail} numberOfLines={2}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.checked && <Check size={14} color={colors.textPrimary} />}
    </Pressable>
  )
}

/** Rows inside one option's card, a hairline between each. */
export function OptionRowList({ children }: { children: ReactNode[] }) {
  // Children.map keys each result by its child's own key.
  return (
    <>
      {Children.map(children, (child, i) => (
        <>
          {i > 0 && <View style={styles.filterSeparator} />}
          {child}
        </>
      ))}
    </>
  )
}

function ChoiceRows<Id extends string>(props: {
  choices: readonly WorkspaceViewChoice<Id>[]
  selected: Id
  onSelect: (id: Id) => void
}) {
  return (
    <OptionRowList>
      {props.choices.map((choice) => (
        <CheckRow
          key={choice.id}
          label={choice.label}
          detail={choice.description}
          checked={choice.id === props.selected}
          onPress={() => props.onSelect(choice.id)}
        />
      ))}
    </OptionRowList>
  )
}

const pickerChoices = <Id extends string>(
  options: readonly { value: Id; label: string; subtitle?: string }[]
): WorkspaceViewChoice<Id>[] =>
  options.map((option) => ({
    id: option.value,
    label: option.label,
    ...(option.subtitle ? { description: option.subtitle } : {})
  }))

function HostsRows({ controller, hosts }: WorkspaceOptionRowsProps) {
  const { settings, state } = controller
  const visible = state.filters.visibleHostIds
  const write = (next: ExecutionHostId[] | null | undefined) => {
    // undefined: the last shown host cannot be turned off.
    if (next !== undefined) {
      settings.setFilter('visibleHostIds', next)
    }
  }
  return (
    <OptionRowList>
      {[
        <CheckRow
          key="all"
          label="All hosts"
          detail="Show every host"
          checked={!visible}
          onPress={() => write(toggleAllVisibleHosts(hosts, visible))}
        />,
        ...hosts.map((host) => (
          <CheckRow
            key={host.id}
            label={host.label}
            checked={!visible || visible.includes(host.id)}
            onPress={() => write(toggleVisibleHostRow(hosts, visible, host))}
          />
        ))
      ]}
    </OptionRowList>
  )
}

function ProjectsRows({ controller }: WorkspaceOptionRowsProps) {
  const { settings, state } = controller
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const repos = controller.sectionsResult.uniqueRepos.filter(
    (repo) => !needle || repo.name.toLowerCase().includes(needle)
  )
  return (
    <>
      <View style={styles.optionSearch}>
        <MobileSearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search projects…"
          accessibilityLabel="Search projects"
        />
      </View>
      <OptionRowList>
        {repos.map((repo) => (
          <CheckRow
            key={repo.key}
            label={repo.name}
            checked={state.filters.filterRepoIds.includes(repo.id)}
            onPress={() => settings.toggleRepoFilter(repo.id)}
            leading={<View style={[styles.filterRepoDot, { backgroundColor: repo.color }]} />}
          />
        ))}
      </OptionRowList>
    </>
  )
}

function CardPropertyRows(props: {
  controller: HostScreenController
  choices: readonly WorkspaceViewChoice<WorktreeCardProperty>[]
}) {
  const { settings, state } = props.controller
  return (
    <OptionRowList>
      {props.choices.map((choice) => (
        <CheckRow
          key={choice.id}
          label={choice.label}
          checked={state.cardView.worktreeCardProperties.includes(choice.id)}
          onPress={() => settings.toggleCardProperty(choice.id)}
        />
      ))}
    </OptionRowList>
  )
}

function filterRow(key: Extract<WorkspaceViewOptionKey, `hide${string}` | `always${string}`>) {
  const label = WORKSPACE_VIEW_OPTIONS.find((option) => option.key === key)?.label ?? key
  return function FilterRow({ controller }: WorkspaceOptionRowsProps) {
    const value = controller.state.filters[key]
    // Absent means on (#8873), so only an explicit false reads as off.
    const checked = key === 'alwaysShowDefaultBranchWorkspace' ? value !== false : value === true
    return (
      <CheckRow
        label={label}
        checked={checked}
        indent={key === 'alwaysShowDefaultBranchWorkspace'}
        onPress={() => controller.settings.setFilter(key, !checked)}
      />
    )
  }
}

/** One phone control per shared option; a new option fails to compile until it has one. */
export const WORKSPACE_OPTION_ROWS: Record<
  WorkspaceViewOptionKey,
  ComponentType<WorkspaceOptionRowsProps>
> = {
  hosts: HostsRows,
  projects: ProjectsRows,
  groupBy: ({ controller }) => (
    <ChoiceRows
      choices={pickerChoices(WORKSPACE_GROUP_OPTIONS)}
      selected={controller.state.groupMode}
      onSelect={controller.settings.handleGroupChange}
    />
  ),
  sortBy: ({ controller }) => (
    <ChoiceRows
      choices={pickerChoices(WORKSPACE_SORT_OPTIONS)}
      selected={controller.state.sortMode}
      onSelect={controller.settings.handleSortChange}
    />
  ),
  projectOrderBy: ({ controller }) => (
    <ChoiceRows
      choices={WORKSPACE_PROJECT_ORDER_CHOICES}
      selected={controller.state.cardView.projectOrderBy}
      onSelect={controller.settings.setProjectOrderBy}
    />
  ),
  cardLayout: ({ controller }) => (
    <ChoiceRows
      choices={WORKSPACE_CARD_LAYOUT_CHOICES}
      selected={controller.state.cardSettings.compactWorktreeCards ? 'compact' : 'detailed'}
      onSelect={controller.settings.setCardLayout}
    />
  ),
  cardProperties: ({ controller }) => (
    <>
      <CardPropertyRows controller={controller} choices={WORKSPACE_CARD_PROPERTY_CHOICES} />
      <Text style={styles.optionSubheading}>Agent activity layout</Text>
      <ChoiceRows
        choices={WORKSPACE_AGENT_ACTIVITY_LAYOUT_CHOICES}
        selected={controller.state.cardView.agentActivityDisplayMode}
        onSelect={controller.settings.setAgentActivityDisplayMode}
      />
    </>
  ),
  cardDisplay: ({ controller }) => (
    <CardPropertyRows
      controller={controller}
      // The phone cannot see the desktop's project groups, so it uses the plain label.
      choices={WORKSPACE_CARD_DISPLAY_CHOICES.map((choice) => ({
        id: choice.id,
        label: getWorkspaceCardDisplayChoiceLabel(choice, false)
      }))}
    />
  ),
  hideSleepingWorkspaces: filterRow('hideSleepingWorkspaces'),
  alwaysShowDefaultBranchWorkspace: filterRow('alwaysShowDefaultBranchWorkspace'),
  hideDefaultBranchWorkspace: filterRow('hideDefaultBranchWorkspace'),
  hideAutomationGeneratedWorkspaces: filterRow('hideAutomationGeneratedWorkspaces'),
  hideCliCreatedWorkspaces: filterRow('hideCliCreatedWorkspaces'),
  hideWorkspacesFromOtherDevices: filterRow('hideWorkspacesFromOtherDevices'),
  hideDetachedHeadWorkspaces: filterRow('hideDetachedHeadWorkspaces')
}
