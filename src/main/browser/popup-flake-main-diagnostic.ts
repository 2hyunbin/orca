import { app } from 'electron'

// DIAGNOSTIC(popup-flake): temporary main-process timing probe, removed before merge.
export function installPopupFlakeMainDiagnostics(): void {
  const t0 = Date.now()
  const log = (message: string): void => {
    process.stderr.write(`[popup-flake-main] +${Date.now() - t0}ms ${message}\n`)
  }
  void app.whenReady().then(() => {
    log(`ready gpu=${JSON.stringify(app.getGPUFeatureStatus())}`)
    for (const delay of [2_000, 8_000, 20_000, 40_000]) {
      setTimeout(() => {
        const metrics = app
          .getAppMetrics()
          .map((m) => `${m.type}:${m.cpu.cumulativeCPUUsage?.toFixed(2) ?? '?'}`)
          .join(',')
        log(`metrics ${metrics}`)
      }, delay).unref()
    }
  })
  app.on('gpu-info-update', () => log('gpu-info-update'))
  app.on('child-process-gone', (_event, details) => log(`child-gone ${JSON.stringify(details)}`))
  app.on('render-process-gone', (_event, _contents, details) =>
    log(`render-gone ${JSON.stringify(details)}`)
  )
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-finish-load', () => {
      const url = contents.getURL().slice(0, 60)
      log(`loaded ${url}`)
      void contents
        .executeJavaScript('new Promise((r) => requestAnimationFrame(() => r(0)))')
        .then(() => log(`first-raf ${url}`))
        .catch(() => {})
    })
  })
}
