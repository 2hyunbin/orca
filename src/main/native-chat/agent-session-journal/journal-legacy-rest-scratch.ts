import { createHash } from 'node:crypto'
import { existsSync, opendirSync, type Dir } from 'node:fs'
import { join } from 'node:path'
import {
  JournalStructuralScratch,
  type JournalStructuralCheckpoint
} from './journal-structural-scratch'

type Saved = JournalStructuralCheckpoint & { cleanup?: boolean }
const FIXED = 'journal-rest-upgrade-scratch.db'
const PREFIX = 'journal-rest-upgrade-'

export function legacyRestScratchPath(directory: string, id: string): string {
  return join(
    directory,
    `${PREFIX}${createHash('sha256').update(Buffer.from(id, 'utf16le')).digest('hex')}.db`
  )
}

/** One open derived database; addressed filenames locate progress but never authenticate it. */
export class LegacyRestScratch {
  private active?: { id: string; scratch: JournalStructuralScratch }
  private directory?: Dir
  private fixedChecked = false
  private fixedCandidate?: string
  private exhausted = false

  constructor(private readonly stateDirectory: string) {}

  discover(): string | undefined | null {
    if (this.exhausted) {
      return null
    }
    this.closeActive()
    if (!this.fixedChecked) {
      this.fixedChecked = true
      const id = this.inspect(FIXED)
      this.fixedCandidate = id
      return id
    }
    this.directory ??= opendirSync(this.stateDirectory)
    const entry = this.directory.readSync()
    if (!entry) {
      this.directory.closeSync()
      this.directory = undefined
      this.exhausted = true
      return null
    }
    if (!/^journal-rest-upgrade-[a-f0-9]{64}\.db$/.test(entry.name)) {
      return undefined
    }
    return this.inspect(entry.name)
  }

  open(id: string, create: boolean): JournalStructuralScratch | undefined {
    if (this.active?.id === id) {
      return this.active.scratch
    }
    this.closeActive()
    if (!this.fixedChecked) {
      this.fixedChecked = true
      this.fixedCandidate = this.inspect(FIXED)
    }
    const name = id === this.fixedCandidate ? FIXED : this.filename(id)
    const path = join(this.stateDirectory, name)
    if (!create && !existsSync(path)) {
      return undefined
    }
    const scratch = new JournalStructuralScratch(path)
    const saved = scratch.load<Saved>()
    if (saved && saved.sessionId !== id) {
      scratch.close()
      throw new Error('derived checkpoint candidate does not match its location')
    }
    this.active = { id, scratch }
    return scratch
  }

  close(): void {
    this.closeActive()
    this.directory?.closeSync()
    this.directory = undefined
  }

  private filename(id: string): string {
    return legacyRestScratchPath('', id)
  }

  private inspect(name: string): string | undefined {
    const path = join(this.stateDirectory, name)
    if (!existsSync(path)) {
      return undefined
    }
    const scratch = new JournalStructuralScratch(path)
    try {
      const saved = scratch.load<Saved>()
      if (!saved || typeof saved.sessionId !== 'string') {
        return undefined
      }
      if (name !== FIXED && name !== this.filename(saved.sessionId)) {
        throw new Error('derived checkpoint candidate does not match its location')
      }
      return saved.sessionId
    } finally {
      scratch.close()
    }
  }

  private closeActive(): void {
    this.active?.scratch.close()
    this.active = undefined
  }
}
