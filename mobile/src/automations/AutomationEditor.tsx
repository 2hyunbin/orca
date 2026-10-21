import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileAutomation } from './automation-reply-schema'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'
import type { MobileNewTabAgentOption } from '../session/mobile-new-tab-agent-options'
import { AutomationAdvancedFields } from './AutomationAdvancedFields'
import { formatAutomationSchedule } from '../../../src/shared/automation-schedules'
import {
  AutomationButton,
  AutomationChoice,
  AutomationField,
  AutomationMetadata
} from './AutomationControls'
import { AutomationScheduleFields } from './AutomationScheduleFields'
import {
  automationSetupKey,
  workspaceMatchesSetup,
  loadAutomationAgents,
  loadAutomationTargets,
  type AutomationTargets
} from './automation-target-inventory'
import {
  newAutomationDraft,
  validateAutomationDraft,
  type AutomationDraft
} from './automation-draft'
import { automationErrorMessage } from './automation-error'
import { automationStyles as styles } from './automation-styles'

export function AutomationEditor(props: {
  client: RpcClient
  current?: MobileAutomation
  initialDraft?: AutomationDraft
  onDraftChange: (draft: AutomationDraft) => void
  busy: boolean
  connected: boolean
  capabilities: readonly string[]
  onCancel: () => void
  onSave: (draft: AutomationDraft, original: AutomationDraft, targets: AutomationTargets) => void
}) {
  const [draft, setDraft] = useState(() => props.initialDraft ?? newAutomationDraft(props.current))
  const original = useRef(newAutomationDraft(props.current))
  const initialized = useRef(false)
  const [targets, setTargets] = useState<AutomationTargets | null>(null)
  const [agents, setAgents] = useState<MobileNewTabAgentOption[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [step, setStep] = useState(props.initialDraft ? 3 : 1)
  const [advanced, setAdvanced] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inventoryLimit, setInventoryLimit] = useState(200)
  const [reload, setReload] = useState(0)
  const disabled = props.busy || !props.connected || !targets
  const setup = targets?.setups.find((entry) => automationSetupKey(entry) === draft.setupId)
  const workspaces =
    targets?.workspaces.filter((workspace) => setup && workspaceMatchesSetup(workspace, setup)) ??
    []

  useEffect(() => {
    if (!props.connected) {
      return
    }
    let active = true
    const generation = props.client.getGeneration?.()
    void loadAutomationTargets(props.client, inventoryLimit)
      .then((next) => {
        if (!active || generation !== props.client.getGeneration?.()) {
          return
        }
        setTargets(next)
        setError(null)
        if (!initialized.current) {
          initialized.current = true
          const initial = newAutomationDraft(props.current)
          const target =
            next.setups.find((entry) => automationSetupKey(entry) === initial.setupId) ??
            (props.current
              ? !props.current.runContext &&
                next.setups.filter((entry) => entry.repoId === props.current?.projectId).length ===
                  1
                ? next.setups.find((entry) => entry.repoId === props.current?.projectId)
                : undefined
              : next.setups.find((entry) => !entry.hostId.startsWith('runtime:')))
          initial.setupId = target ? automationSetupKey(target) : initial.setupId
          if (!props.current && target?.kind === 'folder') {
            initial.workspaceMode = 'existing'
          }
          original.current = { ...initial }
          setDraft(props.initialDraft ?? initial)
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(automationErrorMessage(failure))
        }
      })
    return () => {
      active = false
    }
  }, [props.client, props.connected, props.current, reload, inventoryLimit])

  useEffect(() => {
    if (!setup || !props.connected) {
      setAgentsLoading(false)
      return
    }
    let active = true
    const generation = props.client.getGeneration?.()
    setAgentsLoading(true)
    void loadAutomationAgents(
      props.client,
      setup,
      draft.workspaceMode === 'existing' ? draft.workspaceId || undefined : undefined
    )
      .then((options) => {
        if (!active || generation !== props.client.getGeneration?.()) {
          return
        }
        setAgents(options)
        setDraft((current) =>
          current.agentId ? current : { ...current, agentId: options[0]?.agent ?? null }
        )
      })
      .catch((failure: unknown) => {
        if (active) {
          setAgents([])
          setError(automationErrorMessage(failure))
        }
      })
      .finally(() => {
        if (active) {
          setAgentsLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [props.client, props.connected, setup, draft.workspaceMode, draft.workspaceId])

  useEffect(() => {
    props.onDraftChange(draft)
  }, [draft, props.onDraftChange])

  const agentOptions = agents.map((option) => ({ value: option.agent, label: option.label }))
  if (draft.agentId && !agentOptions.some((option) => option.value === draft.agentId)) {
    agentOptions.unshift({
      value: draft.agentId,
      label: `${MOBILE_TUI_AGENT_LABELS[draft.agentId]} (saved)`
    })
  }
  function change(patch: Partial<AutomationDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
    setError(null)
  }
  function next() {
    const validation = validateAutomationDraft(draft, step, props.current)
    if (validation) {
      setError(validation)
      return
    }
    if (!targets || (!props.current && !setup)) {
      setError('Choose a project set up on this host.')
      return
    }
    if (step < 3) {
      setStep(step + 1)
    } else {
      props.onSave(draft, original.current, targets)
    }
  }
  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        <Text style={[styles.title, styles.grow]}>
          {props.current ? 'Edit automation' : 'New automation'}
        </Text>
        <AutomationButton label="Cancel" onPress={props.onCancel} disabled={props.busy} />
      </View>
      <Text style={styles.meta}>
        {step} of 3 · {step === 1 ? 'Task' : step === 2 ? 'Schedule' : 'Review'}
      </Text>
      {error ? (
        <View style={styles.stack}>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          {!targets ? (
            <AutomationButton
              label="Retry project loading"
              onPress={() => setReload((value) => value + 1)}
              disabled={props.busy || !props.connected}
            />
          ) : null}
        </View>
      ) : null}
      {!targets && !error ? <Text style={styles.meta}>Loading projects…</Text> : null}
      {step === 1 ? (
        <>
          <AutomationField
            label="Name"
            value={draft.name}
            onChange={(name) => change({ name })}
            disabled={disabled}
          />
          <AutomationField
            label="Instructions"
            value={draft.prompt}
            onChange={(prompt) => change({ prompt })}
            multiline
            disabled={disabled}
          />
          <AutomationChoice
            label="Project and host setup"
            value={draft.setupId}
            options={[
              ...(targets?.setups
                .filter((entry) => !entry.hostId.startsWith('runtime:'))
                .map((entry) => ({
                  value: automationSetupKey(entry),
                  label: entry.label,
                  subtitle: `${entry.displayName} · ${entry.path}`
                })) ?? []),
              ...(!setup && props.current
                ? [
                    {
                      value: draft.setupId,
                      label: 'Saved target',
                      subtitle: props.current.runContext?.path ?? props.current.projectId
                    }
                  ]
                : [])
            ]}
            disabled={disabled || !targets}
            onSelect={(setupId) => {
              const target = targets?.setups.find((entry) => automationSetupKey(entry) === setupId)
              change({
                setupId,
                workspaceId: '',
                workspaceMode: target?.kind === 'folder' ? 'existing' : draft.workspaceMode,
                reuseSession: false,
                agentId: null
              })
            }}
          />
          <AutomationChoice
            label="Workspace"
            value={draft.workspaceMode}
            options={[
              {
                value: 'new_per_run',
                label: 'New workspace per run',
                disabled: setup?.kind === 'folder'
              },
              { value: 'existing', label: 'Use an existing workspace' }
            ]}
            onSelect={(workspaceMode) => change({ workspaceMode, reuseSession: false })}
            disabled={disabled}
          />
          {draft.workspaceMode === 'existing' ? (
            <AutomationChoice
              label="Existing workspace"
              value={draft.workspaceId}
              options={[
                ...workspaces.map((workspace) => ({
                  value: workspace.worktreeId,
                  label: workspace.displayName || workspace.path,
                  subtitle: workspace.path
                })),
                ...(props.current &&
                draft.workspaceId &&
                !workspaces.some((workspace) => workspace.worktreeId === draft.workspaceId)
                  ? [
                      {
                        value: draft.workspaceId,
                        label: 'Saved workspace',
                        subtitle: draft.workspaceId
                      }
                    ]
                  : [])
              ]}
              onSelect={(workspaceId) =>
                change({ workspaceId, agentId: props.current?.agentId ?? null })
              }
              disabled={disabled || !targets}
            />
          ) : null}
          {targets?.coverage.truncated ? (
            <AutomationButton
              label="Load more workspaces"
              onPress={() =>
                setInventoryLimit(Math.max(inventoryLimit + 200, targets.coverage.totalCount))
              }
              disabled={props.busy || !props.connected}
            />
          ) : null}
          {setup && targets?.coverage.hostScope.omittedHostIds.includes(setup.hostId) ? (
            <Text style={styles.meta}>
              This host’s workspace inventory is incomplete. Refresh or load more workspaces.
            </Text>
          ) : null}
          <AutomationChoice
            label={agentsLoading ? 'Agent · detecting…' : 'Agent'}
            value={draft.agentId ?? ''}
            options={agentOptions}
            onSelect={(value) => {
              const agent = agentOptions.find((option) => option.value === value)
              if (agent) {
                change({ agentId: agent.value })
              }
            }}
            disabled={disabled || agentsLoading}
          />
          {!agentsLoading && agents.length === 0 && !props.current ? (
            <Text style={styles.meta}>Install and enable an agent on this host, then retry.</Text>
          ) : null}
          <AutomationButton
            label={advanced ? 'Hide advanced options' : 'Advanced options'}
            onPress={() => setAdvanced(!advanced)}
          />
          {advanced ? (
            <AutomationAdvancedFields
              draft={draft}
              change={change}
              disabled={disabled}
              capabilities={props.capabilities}
            />
          ) : null}
        </>
      ) : step === 2 ? (
        <AutomationScheduleFields draft={draft} change={change} disabled={disabled} />
      ) : (
        <View style={styles.card}>
          <Text style={styles.title}>{draft.name}</Text>
          <AutomationMetadata label="Instructions" value={draft.prompt} />
          <AutomationMetadata
            label="Agent"
            value={draft.agentId ? MOBILE_TUI_AGENT_LABELS[draft.agentId] : 'Choose an agent'}
          />
          <AutomationMetadata
            label="Project"
            value={setup ? `${setup.label} · ${setup.path}` : 'Saved target'}
          />
          <AutomationMetadata
            label="Workspace"
            value={
              draft.workspaceMode === 'existing'
                ? (workspaces.find((entry) => entry.worktreeId === draft.workspaceId)
                    ?.displayName ?? draft.workspaceId)
                : 'New workspace per run'
            }
          />
          <AutomationMetadata
            label="Schedule"
            value={`${formatAutomationSchedule(draft.rrule)} · ${draft.timezone}`}
          />
        </View>
      )}
      <View style={styles.row}>
        {step > 1 ? (
          <AutomationButton label="Back" onPress={() => setStep(step - 1)} disabled={props.busy} />
        ) : null}
        <View style={styles.grow}>
          <AutomationButton
            label={step < 3 ? 'Continue' : props.current ? 'Save changes' : 'Create automation'}
            primary
            onPress={next}
            disabled={disabled || !targets || agentsLoading}
          />
        </View>
      </View>
    </View>
  )
}
