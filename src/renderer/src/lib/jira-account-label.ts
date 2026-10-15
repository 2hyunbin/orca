import type { JiraSite, JiraViewer } from '../../../shared/jira-types'

/** Display label for a Jira connection; identity is the host plus providerIdentity.siteId. */
export function getJiraAccountLabel(
  account:
    | Partial<Pick<JiraSite, 'email' | 'displayName' | 'siteUrl'>>
    | JiraViewer
    | null
    | undefined
): string | null {
  if (!account) {
    return null
  }
  const siteUrl = 'siteUrl' in account ? account.siteUrl : null
  return account.email?.trim() || account.displayName?.trim() || siteUrl?.trim() || null
}
