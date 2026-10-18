import { expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import { CLAUDE_SESSION_OPTION_CATALOG as seed } from './agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  commitStructuredAgentSessionOption,
  resetStructuredAgentSessionCurrentOptions,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection
} from './structured-agent-session-option-view'

const row = (id: string) => ({ id, label: id, isDefault: true, efforts: [] })
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
  value,
  label: value === 'high' ? 'High' : value
}))
const catalog = { origin: 'probe' as const, fetchedAt: 1, models: [{ ...row('sonnet'), efforts }] }
const fresh = () => createStructuredAgentSessionOptionState('claude', seed)
const inventory = (
  state = fresh(),
  listing: AgentSessionModelCatalogResult = catalog,
  newLaunch = true
) => applyStructuredAgentSessionModelCatalog(state, seed, listing, { newLaunch })
const picked = { model: 'opus[1m]', effort: 'high' }
const selection = (state: ReturnType<typeof fresh>) =>
  structuredAgentSessionSendSelection('claude', structuredAgentSessionOptionSnapshot(state))

it('composes an off-list client seed beside a full list and carries its literal effort to Send', () => {
  const state = inventory()
  const view = structuredAgentSessionOptionView(state, picked, {}, true)
  const snapshot = structuredAgentSessionOptionSnapshot(view)
  expect(snapshot.find((entry) => entry.id === 'model')?.kind).toEqual({
    type: 'select',
    currentValue: 'opus[1m]',
    choices: [
      { value: 'sonnet', label: 'sonnet' },
      { value: 'opus[1m]', label: 'opus[1m]' }
    ]
  })
  expect(snapshot.find((entry) => entry.id === 'effort')).toMatchObject({
    kind: { type: 'select', currentValue: 'high', choices: [{ value: 'high', label: 'High' }] },
    valueSource: 'dispatched',
    settable: false
  })
  expect(selection(view)).toEqual(picked)
  expect(state.record.model).toBeUndefined()
  expect(state.catalog?.models.map((entry) => entry.id)).toEqual(['sonnet'])
})

it('preserves a running or restored pick in both response orders and accepts later inventory', () => {
  for (const order of ['options-first', 'catalog-first']) {
    let state = fresh()
    const options = {
      models: ['sonnet', 'opus[1m]'].map((id) => ({ ...row(id), efforts, supportsFastMode: true })),
      fastModeSupport: { supported: true },
      current: { ...picked, fastMode: true, confirmed: ['model', 'effort', 'fastMode'] }
    }
    const fast = (next: typeof state) =>
      structuredAgentSessionOptionSnapshot(next).find((entry) => entry.id === 'fastMode')
    const reported = applyStructuredAgentSessionOptions(state, seed, options)
    expect(fast(resetStructuredAgentSessionCurrentOptions(reported))).toBeUndefined()
    state =
      order === 'options-first'
        ? inventory(reported, catalog, false)
        : applyStructuredAgentSessionOptions(inventory(), seed, options)
    state = inventory(state, { ...catalog, models: [row('new-installed')] }, false)
    expect(state.catalog?.models.map((entry) => entry.id)).toEqual(['new-installed'])
    const effort = (next: typeof state) =>
      structuredAgentSessionOptionSnapshot(next).find((row) => row.id === 'effort')
    expect(fast(state)).toMatchObject({
      settable: true,
      kind: { type: 'boolean', currentValue: true }
    })
    expect(fast(resetStructuredAgentSessionCurrentOptions(state))).toBeUndefined()
    const pickedOther = commitStructuredAgentSessionOption(
      { ...state, record: structuredClone(state.record) },
      'model',
      'new-installed'
    )
    expect(fast(pickedOther)).toBeUndefined()
    expect(fast(inventory())).toBeUndefined()
    expect(effort(state)).toMatchObject({ settable: true, kind: { choices: efforts } })
    expect(effort(resetStructuredAgentSessionCurrentOptions(state))).toMatchObject({
      settable: false,
      valueSource: 'dispatched',
      kind: { currentValue: 'high', choices: [{ value: 'high', label: 'high' }] }
    })
    expect(effort(inventory())).toBeUndefined()
    const changed = applyStructuredAgentSessionOptions(state, seed, {
      models: [row('new-installed')],
      current: { model: 'new-installed' }
    })
    expect(effort(changed)).toBeUndefined()
    // Restore the current model before checking the opaque 302 scalar.
    state = applyStructuredAgentSessionOptions(state, seed, options)
    expect(selection(state)).toEqual(picked)
    for (const effortsKnown of [undefined, false] as const) {
      const currentOnly = applyStructuredAgentSessionOptions(state, seed, {
        models: [{ ...row('opus[1m]'), effortsKnown, supportsFastMode: true }],
        fastModeSupport: { supported: true },
        listedModelIds: [],
        current: { ...picked, fastMode: true }
      })
      expect(currentOnly.catalog).toBe(state.catalog)
      expect(fast(currentOnly)).toMatchObject({ kind: { currentValue: true } })
      expect(effort(currentOnly)).toMatchObject({
        settable: false,
        kind: { currentValue: 'high', choices: [{ value: 'high', label: 'high' }] }
      })
    }
    expect(
      fast(
        applyStructuredAgentSessionOptions(state, seed, { ...options, fastModeSupport: undefined })
      )
    ).toBeUndefined()
  }
})

it('keeps an unpicked launch and restores discovered efforts after a literal model pick', () => {
  expect(
    selection(inventory(fresh(), { ...catalog, listingNamesConfiguredModel: true }))
  ).toBeUndefined()
  const unknown = applyStructuredAgentSessionOptions(fresh(), seed, {
    models: [{ ...row(picked.model), effortsKnown: false }],
    current: { model: picked.model }
  })
  const exact = { ...row(picked.model), efforts }
  const listed = inventory(unknown, { ...catalog, models: [exact] }, false)
  expect(
    structuredAgentSessionOptionSnapshot(listed).find((entry) => entry.id === 'effort')
  ).toMatchObject({ settable: true, kind: { choices: efforts } })
  const selected = commitStructuredAgentSessionOption(listed, 'effort', 'high')
  expect(selection(selected)).toEqual(picked)
})
