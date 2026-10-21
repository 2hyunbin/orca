import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { installExternalConversations } from './external-conversations-install'

type SettingsListener = (updates: Partial<GlobalSettings>) => void

function fakeStore(initial: Partial<GlobalSettings>) {
  let settings = { ...initial }
  const listeners = new Set<SettingsListener>()
  return {
    listeners,
    getSettings: () => settings,
    onSettingsChanged: (listener: SettingsListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update(updates: Partial<GlobalSettings>) {
      settings = { ...settings, ...updates }
      listeners.forEach((listener) => listener(updates))
    }
  }
}

describe('installExternalConversations', () => {
  it('starts nothing while connectors are off', () => {
    const store = fakeStore({})
    const connectors = installExternalConversations(store)
    expect(connectors.current()).toBeNull()
    store.update({ experimentalConnectors: false })
    expect(connectors.current()).toBeNull()
  })

  it('builds the seam at install when the setting is already on', () => {
    const connectors = installExternalConversations(fakeStore({ experimentalConnectors: true }))
    expect(connectors.current()?.signal.aborted).toBe(false)
  })

  it('disposes the seam on disable and builds a fresh one on re-enable', () => {
    const store = fakeStore({ experimentalConnectors: true })
    const connectors = installExternalConversations(store)
    const first = connectors.current()

    store.update({ experimentalConnectors: false })
    expect(connectors.current()).toBeNull()
    expect(first?.signal.aborted).toBe(true)
    expect(first?.signal.reason).toBe('connectors_disabled')

    store.update({ experimentalConnectors: true })
    const second = connectors.current()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(store.listeners.size).toBe(1)
  })

  it('keeps the seam through unrelated settings changes', () => {
    const store = fakeStore({ experimentalConnectors: true })
    const connectors = installExternalConversations(store)
    const seam = connectors.current()
    store.update({ editorAutoSave: true })
    expect(connectors.current()).toBe(seam)
  })

  it('stays off without a store', () => {
    expect(installExternalConversations(null).current()).toBeNull()
  })
})
