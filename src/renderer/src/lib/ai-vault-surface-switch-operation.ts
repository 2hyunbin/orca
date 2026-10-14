import type { AiVaultPrepareSessionResumeArgs } from '../../../shared/ai-vault-resume-preparation'
export type AiVaultSurfaceSwitchOperation = {
  signal: AbortSignal
  requestContext?: AiVaultPrepareSessionResumeArgs['requestContext']
  isSourceOpen: () => boolean
  onDispatch?: () => void
}
