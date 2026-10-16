import { z } from 'zod'
import type { ControlFlagParse } from './relay-control-flag-channel.js'

// Written only by the database move tool, in the same control bucket as the cell flags.
// Absent means the relay runs on DATABASE_URL alone, exactly as before the pointer existed.
export const DATABASE_TARGET_POINTER_OBJECT = 'database-target.json'
export const DATABASE_TARGET_POINTER_APPLIED_EVENT = 'orca_relay_database_target_pointer_applied'
// Bounds a hold below the 45 s heartbeat staleness, whatever the object says.
export const DATABASE_QUIESCE_MAX_MS = 20_000

const DedicatedTargetSchema = z.object({
  instanceConnectionName: z.string().regex(/^[a-z][a-z0-9-]*(?::[a-z0-9-]+){2}$/),
  databaseUrlSecret: z
    .string()
    .regex(/^projects\/[^/]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[A-Za-z0-9_-]+$/)
})

const QuiesceSchema = z
  .object({
    id: z.string().min(1).max(128),
    startsAt: z.number().int().positive(),
    until: z.number().int().positive()
  })
  .refine(
    (quiesce) =>
      quiesce.until > quiesce.startsAt && quiesce.until - quiesce.startsAt <= DATABASE_QUIESCE_MAX_MS
  )

const PointerSchema = z.object({
  version: z.literal(1),
  dedicated: DedicatedTargetSchema,
  // The newest authority generation the tool has written; no process serves from a target below it.
  generation: z.number().int().min(0).optional(),
  quiesce: QuiesceSchema.optional()
})

export type DatabaseTargetPointer = z.infer<typeof PointerSchema>
export type DedicatedDatabaseTarget = DatabaseTargetPointer['dedicated']
export type DatabaseQuiesce = NonNullable<DatabaseTargetPointer['quiesce']>

// A bad value voids the whole object, so the process keeps what it last applied.
export const parseDatabaseTargetPointer: ControlFlagParse<DatabaseTargetPointer | null> = (
  body
) => {
  const parsed = PointerSchema.safeParse(body)
  return parsed.success ? { flags: parsed.data, ignoredKeys: [] } : null
}

export function sameDedicatedDatabaseTarget(
  left: DedicatedDatabaseTarget,
  right: DedicatedDatabaseTarget
): boolean {
  return (
    left.instanceConnectionName === right.instanceConnectionName &&
    left.databaseUrlSecret === right.databaseUrlSecret
  )
}
