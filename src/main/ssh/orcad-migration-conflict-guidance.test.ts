import { describe, expect, it } from 'vitest'
import { orcadMigrationConflictGuidance } from './orcad-migration-conflict-guidance'

const NO_DESKTOP_STEP = [
  'project_group_id',
  'folder_workspace_id',
  'dormant_id',
  'dormant_focus',
  'client_state',
  'close_intent_destination',
  'snapshot_destination'
]

describe('orcad migration conflict guidance', () => {
  it('points every conflict retrying can’t clear at the plain SSH terminal, naming the code', () => {
    for (const kind of NO_DESKTOP_STEP) {
      const text = orcadMigrationConflictGuidance(
        new Error(`orcad_migration_${kind}_conflict:ui:workspaceHostScope`)
      )
      expect(text).toContain('Retrying won’t clear it.')
      expect(text).toContain('choose Open plain SSH terminal')
      expect(text).toContain(`orcad_migration_${kind}_conflict`)
    }
  })

  it('keeps the specific way out where the desktop has one', () => {
    expect(
      orcadMigrationConflictGuidance(
        new Error('orcad_migration_repository_path_conflict:/home/me/app')
      )
    ).toContain('remove that project from this desktop and connect again')
  })

  it('is null for anything that is not a conflict', () => {
    expect(orcadMigrationConflictGuidance(new Error('ECONNRESET'))).toBeNull()
  })
})
