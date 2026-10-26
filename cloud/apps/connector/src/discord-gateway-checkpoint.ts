import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { GatewayCheckpoint } from './discord-gateway-session.js'

// The one checkpoint row.
const SLOT = 1

// Each leader takes the next epoch and commits only under it, so a leader that lost its lock can't
// route or move the checkpoint once its successor has started. Returns where to resume.
export async function takeCheckpoint(
  database: CloudDatabase,
  now: number
): Promise<{ epoch: number; resumeFrom: GatewayCheckpoint | null }> {
  return await database.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO connector_discord_gateway (slot, epoch, updated_at) VALUES (?, 0, ?)
       ON CONFLICT (slot) DO NOTHING`,
      [SLOT, now]
    )
    const [row] = await transaction.query(
      `UPDATE connector_discord_gateway SET epoch = epoch + 1, updated_at = ? WHERE slot = ?
       RETURNING epoch, session_id, resume_url, sequence`,
      [now, SLOT]
    )
    const epoch = Number(row?.epoch)
    return row?.session_id === null || row?.session_id === undefined
      ? { epoch, resumeFrom: null }
      : {
          epoch,
          resumeFrom: {
            sessionId: String(row.session_id),
            resumeURL: String(row.resume_url),
            sequence: Number(row.sequence)
          }
        }
  })
}

export async function saveCheckpoint(
  transaction: CloudDatabase,
  epoch: number,
  checkpoint: GatewayCheckpoint,
  now: number
): Promise<void> {
  const [saved] = await transaction.query(
    `UPDATE connector_discord_gateway SET session_id = ?, resume_url = ?, sequence = ?,
       updated_at = ?
     WHERE slot = ? AND epoch = ?`,
    [checkpoint.sessionId, checkpoint.resumeURL, checkpoint.sequence, now, SLOT, epoch]
  )
  if (Number(saved?.changes ?? 0) === 0) {
    throw new Error('a newer leader holds the Discord gateway')
  }
}
