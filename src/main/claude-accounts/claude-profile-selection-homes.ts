import type { ClaudeProfileRouter, ClaudeProfileRouterSettings } from './claude-profile-router'

/** Every native switcher destination, even an account whose setup has not created its home. */
export async function claudeProfileSelectionHomes(
  router: ClaudeProfileRouter,
  settings: ClaudeProfileRouterSettings,
  environmentReady: Promise<unknown>
): Promise<string[]> {
  await environmentReady
  const system = router.systemDefaultHome()
  return [
    system,
    ...settings.claudeManagedAccounts
      .filter((account) => account.managedAuthRuntime !== 'wsl')
      .map((account) =>
        router.coveredBySystemDefault(account.id) ? system : router.accountHome(account.id)
      )
  ]
}
