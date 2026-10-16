import type { ProjectAgentSkillRuntime } from '@/lib/project-skill-runtime'

export type OnboardingFeatureSetupRuntimeContext = {
  agentRuntime?: ProjectAgentSkillRuntime
  installDisabledReason: string | null
}

export function getOnboardingFeatureSetupAgentRuntime(
  context: OnboardingFeatureSetupRuntimeContext
): ProjectAgentSkillRuntime | undefined {
  return context.installDisabledReason ? undefined : context.agentRuntime
}
