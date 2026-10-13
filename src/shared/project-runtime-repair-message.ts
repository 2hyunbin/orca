import type { ProjectExecutionRuntimeRepair } from './project-execution-runtime'

export const PROJECT_RUNTIME_REPAIR_MESSAGES = {
  'wsl-unavailable': 'WSL is not available. Switch this project to Windows or repair WSL.',
  'wsl-distro-missing':
    '{{value0}} is not installed in WSL. Choose an installed distro or switch this project to Windows.',
  'wsl-distro-required': 'Choose a WSL distro or switch this project to Windows.'
} as const

export function getProjectRuntimeRepairMessage(repair: ProjectExecutionRuntimeRepair): string {
  return PROJECT_RUNTIME_REPAIR_MESSAGES[repair.reason].replace(
    '{{value0}}',
    repair.preferredRuntime.distro ?? 'WSL'
  )
}
