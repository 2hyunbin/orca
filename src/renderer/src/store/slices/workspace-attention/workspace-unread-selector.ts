/** Whether a workspace row reads as unread for the dot, Dock, palette and sidebar; today its persisted flag. */
export function isWorkspaceUnread(row: { readonly isUnread?: boolean }): boolean {
  return Boolean(row.isUnread)
}
