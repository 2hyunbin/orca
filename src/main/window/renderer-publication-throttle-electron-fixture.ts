import { app, BrowserWindow, type WebContents } from 'electron'
import { startBrowserScreencast } from '../browser/browser-screencast-stream'
import { RendererPublicationThrottle } from './renderer-publication-throttle'

async function run(): Promise<void> {
  await app.whenReady()
  const host = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: { webviewTag: true, backgroundThrottling: false }
  })
  await host.loadURL('data:text/html,<body></body>')
  const throttle = new RendererPublicationThrottle()
  let frames = 0
  let releasesDuringDestruction = 0
  let restoreCalls = 0
  let captureCalls = 0

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const attached = new Promise<WebContents>((resolve) => {
      host.webContents.once('did-attach-webview', (_event, guest) => resolve(guest))
    })
    await host.webContents.executeJavaScript(`(() => {
      const view = document.createElement('webview')
      view.style.cssText = 'width:640px;height:480px'
      view.src = 'about:blank'
      document.body.appendChild(view)
    })()`)
    const guest = await attached
    const release = throttle.acquire({
      isDestroyed: () => guest.isDestroyed(),
      isFocused: () => guest.isFocused(),
      setBackgroundThrottling: (allowed) => {
        if (allowed) {
          restoreCalls += 1
        }
        guest.setBackgroundThrottling(allowed)
      },
      capturePage: (rect, options) => {
        captureCalls += 1
        return guest.capturePage(rect, options)
      }
    })
    await guest.loadURL('data:text/html,<h1>Streamed page</h1>')
    let firstFrame!: () => void
    const ready = new Promise<void>((resolve) => {
      firstFrame = resolve
    })
    const session = await startBrowserScreencast(guest, {
      format: 'jpeg',
      quality: 60,
      maxWidth: 640,
      maxHeight: 480,
      everyNthFrame: 1,
      minFrameIntervalMs: 0,
      onFrame: () => {
        frames += 1
        firstFrame()
      }
    })
    // Match the runtime's promise chain: detach settles done inside native destruction.
    const released = Promise.resolve(session)
      .then((stream) => stream.done)
      .finally(() => {
        if (!guest.isDestroyed()) {
          releasesDuringDestruction += 1
        }
        release()
      })
    await ready
    await host.webContents.executeJavaScript('document.querySelector("webview").remove()')
    await released
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (!guest.isDestroyed()) {
      throw new Error('Streamed guest was not destroyed')
    }
  }

  // A surviving host must still be able to serve another browser operation.
  await host.loadURL('data:text/html,<h1>Host is still reachable</h1>')
  const title = await host.webContents.executeJavaScript('document.querySelector("h1").textContent')
  console.log(
    JSON.stringify({ frames, releasesDuringDestruction, restoreCalls, captureCalls, title })
  )
  host.destroy()
  app.exit(0)
}

const deadline = setTimeout(() => app.exit(2), 30_000)
void run().catch((error: unknown) => {
  clearTimeout(deadline)
  console.error(error)
  app.exit(1)
})
