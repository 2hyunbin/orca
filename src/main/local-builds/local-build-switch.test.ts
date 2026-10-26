import { beforeEach, describe, expect, it, vi } from 'vitest'
import { updaterMainWindow } from '../updater-test-main-window'
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

  it.each(['headless', 'closed', 'successor'] as const)(
    'resolves each dialog parent when manifest loading finishes: %s',
    async (mode) => {
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
      destroyed = true
      if (mode === 'successor') {
        currentWindow = successor
      }
      finishLoading(candidate)
      expect(await selection).toBe(candidate)
      const options = expect.objectContaining({ title: 'Choose a Local Orca Build' })
      expect(showOpenDialog).toHaveBeenCalledWith(
        ...(mode === 'headless' ? [options] : [oldWindow, options])
      )
      const confirmation = expect.objectContaining({ title: 'Use Local Orca Build?' })
      expect(showMessageBox).toHaveBeenCalledWith(
        ...(mode === 'successor' ? [successor, confirmation] : [confirmation])
      )
    }
  )
})
