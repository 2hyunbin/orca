import { getAppEnvironment } from './app-environment'

export function getHostAppVersion(): string {
  const environment = getAppEnvironment()
  return environment.getAppVersion?.() ?? environment.getVersion()
}
