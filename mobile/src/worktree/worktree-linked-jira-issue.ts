/** Whether the row links a Jira issue; reads defensively because rows reach the phone unchecked. */
export function hasLinkedJiraIssue(linkedItems: unknown): boolean {
  return (
    Array.isArray(linkedItems) &&
    linkedItems.some(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        'provider' in item &&
        item.provider === 'jira' &&
        'type' in item &&
        item.type === 'issue'
    )
  )
}
