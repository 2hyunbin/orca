import { app } from 'electron'
import { registerCliForServe } from '../cli/serve-cli-registration'

export function registerCliForHeadlessServe(): Promise<void> {
  return registerCliForServe({
    platform: process.platform,
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    appPath: app.getAppPath()
  })
}
