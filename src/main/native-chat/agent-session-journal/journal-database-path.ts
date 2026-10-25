import { join } from 'node:path'

export function journalDatabasePath(stateDirectory: string): string {
  return join(stateDirectory, 'agent-session-journal.db')
}
