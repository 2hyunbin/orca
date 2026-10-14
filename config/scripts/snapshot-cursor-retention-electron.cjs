const { app, BrowserWindow } = require('electron')

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1' || !process.env.ORCA_CURSOR_RETENTION_PROFILE) {
  throw new Error('Launch through snapshot-cursor-retention-benchmark.mjs')
}
if (process.platform === 'darwin') {
  app.setActivationPolicy('prohibited')
}
app.setPath('userData', process.env.ORCA_CURSOR_RETENTION_PROFILE)

let fixtureWindow
app
  .whenReady()
  .then(async () => {
    fixtureWindow = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 800,
      height: 600,
      webPreferences: { backgroundThrottling: false }
    })
    await fixtureWindow.loadURL(
      'data:text/html,<title>orca-cursor-retention-fixture</title><body></body>'
    )
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })

// Closing the controller's pipe also quits the fixture if the controller dies.
process.stdin.on('end', () => app.quit())
process.stdin.resume()
app.on('window-all-closed', () => app.quit())
