import { beforeEach, describe, expect, it, vi } from 'vitest'
import { updaterMainWindow } from '../updater-test-main-window'
import { SCHEMA_VERSION } from '../../shared/constants'
import { LOCAL_BUILD_COMPATIBILITY_CONTRACT } from '../../shared/local-build-compatibility-contract'
import type { LocalBuildCandidate } from './local-build-candidate'

const { showOpenDialog, showMessageBox, loadCandidate } = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  loadCandidate: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.51' },
  dialog: { showOpenDialog, showMessageBox }
}))
vi.mock('./local-build-candidate', () => ({ loadLocalBuildCandidate: loadCandidate }))
vi.mock('./local-build-compatibility', () => ({
  assertLocalBuildCompatibility: async () => ({ liveTerminalCount: 0 })
}))
import { chooseLocalBuild } from './local-build-switch'

describe('local build dialog parents', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    showOpenDialog.mockResolvedValue({ filePaths: ['/tmp/local-build.yml'], canceled: false })
    showMessageBox.mockResolvedValue({ response: 0 })
  })

  const cases = (['live', 'headless', 'closed', 'successor'] as const).flatMap((mode) =>
    (['confirm', 'cancel', 'reject'] as const).map((outcome) => ({ mode, outcome }))
  )
  it.each(cases)(
    'resolves each dialog parent and preserves $outcome result: $mode',
    async ({ mode, outcome }) => {
      let destroyed = false
      const oldWindow = updaterMainWindow(vi.fn(), () => destroyed)
      const successor = updaterMainWindow(vi.fn())
      let currentWindow = mode === 'headless' ? null : oldWindow
      const candidate: LocalBuildCandidate = {
        version: '1.0.52',
        compatibility: {
          ...LOCAL_BUILD_COMPATIBILITY_CONTRACT,
          readableStateSchemaVersions: [
            ...LOCAL_BUILD_COMPATIBILITY_CONTRACT.readableStateSchemaVersions
          ],
          attachableDaemonProtocolVersions: [
            ...LOCAL_BUILD_COMPATIBILITY_CONTRACT.attachableDaemonProtocolVersions
          ],
          buildId: 'local-test',
          version: '1.0.52',
          commit: 'test-commit',
          platform: 'darwin',
          architecture: 'arm64'
        },
        manifestContent: '',
        artifacts: new Map(),
        close: vi.fn(async () => {})
      }
      let finishLoading: (value: LocalBuildCandidate) => void = () => {}
      loadCandidate.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishLoading = resolve
          })
      )
      const selection = chooseLocalBuild(() => currentWindow)
      await vi.waitFor(() => expect(loadCandidate).toHaveBeenCalledOnce())
      destroyed = mode !== 'live'
      if (mode === 'successor') {
        currentWindow = successor
      }
      const failure = new Error('Native confirmation failed')
      if (outcome === 'reject') {
        showMessageBox.mockRejectedValue(failure)
      } else {
        showMessageBox.mockResolvedValue({ response: outcome === 'confirm' ? 0 : 1 })
      }
      finishLoading(candidate)
      if (outcome === 'reject') {
        await expect(selection).rejects.toBe(failure)
      } else {
        expect(await selection).toBe(outcome === 'confirm' ? candidate : null)
      }
      expect(loadCandidate).toHaveBeenCalledExactlyOnceWith('/tmp/local-build.yml', process.arch)
      expect(candidate.close).toHaveBeenCalledTimes(outcome === 'confirm' ? 0 : 1)
      const options = {
        title: 'Choose a Local Orca Build',
        buttonLabel: 'Choose Build',
        properties: ['openFile'],
        filters: [{ name: 'Orca update manifest', extensions: ['yml'] }]
      }
      expect(showOpenDialog).toHaveBeenCalledWith(
        ...(mode === 'headless' ? [options] : [oldWindow, options])
      )
      const confirmation = {
        type: 'question',
        title: 'Use Local Orca Build?',
        message: '1.0.51 → 1.0.52',
        detail: `No live terminals need to reconnect.\nWorkspace cards and settings are compatible with state schema ${SCHEMA_VERSION}.\n\nThe build must have the same valid code signature as Orca or installation will stop.`,
        buttons: ['Use Local Build', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      }
      expect(showMessageBox).toHaveBeenCalledWith(
        ...(mode === 'successor'
          ? [successor, confirmation]
          : mode === 'live'
            ? [oldWindow, confirmation]
            : [confirmation])
      )
    }
  )
})
