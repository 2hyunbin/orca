import { parentPort, workerData } from 'node:worker_threads'
import { openJournalDatabase } from './journal-database'
import { JournalMaintenance } from './journal-maintenance'

if (!parentPort || typeof workerData !== 'string') {
  throw new Error('journal maintenance requires a worker port and database path')
}
const port = parentPort
const opened = openJournalDatabase(workerData)
if (opened.readOnly) {
  opened.db.close()
  port.close()
} else {
  const maintenance = new JournalMaintenance(() => opened.db, 0)
  port.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'close' in message) {
      maintenance.close()
      opened.db.close()
      port.close()
    } else if (typeof message === 'string') {
      maintenance.appended(message)
    } else if (message === null) {
      maintenance.changed()
    }
  })
}
