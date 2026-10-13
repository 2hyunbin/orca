import type { ElectronApplication } from '@stablyai/playwright-test'

export async function nativePluginViewerSnapshot(app: ElectronApplication) {
  return app.evaluate(async ({ webContents }) =>
    Promise.all(
      webContents
        .getAllWebContents()
        .filter((guest) => guest.getURL().startsWith('orca-plugin-viewer://'))
        .map(async (guest) => {
          const frame = guest.mainFrame.framesInSubtree.find((item) => item !== guest.mainFrame)
          const text = frame ? await frame.executeJavaScript('document.body.innerText') : ''
          return { url: guest.getURL(), text: typeof text === 'string' ? text : '' }
        })
    )
  )
}
