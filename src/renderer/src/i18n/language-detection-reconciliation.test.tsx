// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { UiLanguageDetection } from '../../../shared/ui-locale'

beforeEach(() => vi.resetModules())

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each(['system', 'explicit'] as const)(
  'reconciles late native detection while preserving the %s preference',
  async (preference) => {
    const { getDefaultSettings } = await import('../../../shared/constants')
    const { detectUiLanguage } = await import('../../../shared/ui-locale')
    const { useAppStore } = await import('@/store')
    const { usePluginLanguagePackStore } = await import('@/store/plugin-language-packs')
    const { useLanguageReadiness } = await import('./language-readiness')
    const { I18nProvider } = await import('./I18nProvider')
    const { i18n, loadRendererUiLanguage } = await import('./i18n')
    const { OnboardingLanguageSwitcher } =
      await import('@/components/onboarding/OnboardingLanguageSwitcher')
    await Promise.all([loadRendererUiLanguage('fr'), loadRendererUiLanguage('ja')])
    await i18n.changeLanguage('en')
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['fr-FR'] })
    let finishDetection: (value: UiLanguageDetection) => void = () => {}
    const nativeDetection = new Promise<UiLanguageDetection>((resolve) => {
      finishDetection = resolve
    })
    let settings = getDefaultSettings('/tmp')
    const save = vi.fn(async (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: { getSystemLanguageDetection: () => nativeDetection },
        settings: { set: save },
        telemetryTrack: vi.fn().mockResolvedValue(undefined)
      }
    })
    useAppStore.setState({ settings })
    usePluginLanguagePackStore.setState({ entries: [], loaded: true })
    function OnboardingGate(): React.JSX.Element {
      const ready = useLanguageReadiness((state) => state.ready)
      return ready ? (
        <>
          <p>Onboarding available</p>
          <OnboardingLanguageSwitcher open onOpenChange={vi.fn()} />
        </>
      ) : (
        <p>Waiting for language</p>
      )
    }
    render(
      <I18nProvider>
        <OnboardingGate />
      </I18nProvider>
    )

    expect(screen.getByText('Waiting for language')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(screen.getByText('Onboarding available')).toBeTruthy()
    expect(i18n.language).toBe('fr')
    expect(screen.getByRole('radio', { name: 'Français' }).getAttribute('data-state')).toBe(
      'checked'
    )
    if (preference === 'explicit') {
      await act(async () => {
        fireEvent.click(screen.getByRole('radio', { name: 'English' }))
      })
      expect(useAppStore.getState().settings?.uiLanguage).toBe('en')
      expect(i18n.language).toBe('en')
    }

    await act(async () => finishDetection(detectUiLanguage(['ja-JP'], 'native')))

    const expectedLocale = preference === 'system' ? 'ja' : 'en'
    expect(i18n.language).toBe(expectedLocale)
    expect(useAppStore.getState().settings?.uiLanguage).toBe(
      preference === 'system' ? 'system' : 'en'
    )
    expect(useLanguageReadiness.getState()).toMatchObject({
      ready: true,
      error: false,
      loading: false,
      detection: { locale: 'ja', source: 'native' }
    })
    expect(
      screen
        .getByRole('radio', { name: preference === 'system' ? '日本語' : 'English' })
        .getAttribute('data-state')
    ).toBe('checked')
    expect(screen.getByText(/日本語/, { selector: 'p' })).toBeTruthy()
    expect(save).toHaveBeenCalledTimes(preference === 'system' ? 0 : 1)
  }
)
