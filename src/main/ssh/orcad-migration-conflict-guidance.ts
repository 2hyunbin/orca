/**
 * A move the host's server refuses because it already holds a different copy of something this
 * desktop moves. Retrying never clears that, so the connect names what conflicts and the way out.
 */
const CONFLICT =
  /orcad_migration_(repository_path|repository_id|project_group_id|folder_workspace_id|dormant_id|dormant_focus|client_state|close_intent_destination|snapshot_destination)_conflict(?::(\S+))?/

/** Null for anything that is not such a conflict, including a transient staged claim. */
export function orcadMigrationConflictGuidance(error: unknown): string | null {
  const match = CONFLICT.exec(error instanceof Error ? error.message : String(error))
  if (!match) {
    return null
  }
  const [code, kind, subject] = match
  switch (kind) {
    case 'repository_path':
      return (
        `This host’s managed server already has a project at ${subject}, which another Orca desktop ` +
        'added while this one was moving it. Retrying won’t clear it. To use the server’s project, ' +
        `remove that project from this desktop and connect again. (${code})`
      )
    case 'repository_id':
      return (
        'This host’s managed server already has one of this desktop’s projects with different ' +
        'settings. Retrying won’t clear it. To use the server’s copy, remove that project from this ' +
        `desktop and connect again. (${code})`
      )
    default:
      return (
        'This host’s managed server already holds different saved state for something this desktop ' +
        'is moving, so nothing was moved and this desktop keeps its projects. Retrying won’t clear ' +
        `it. (${code})`
      )
  }
}
