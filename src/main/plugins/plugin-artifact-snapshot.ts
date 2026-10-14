import { createHash } from 'node:crypto'
import { readContainedPluginArtifactText } from './plugin-artifact-file-reader'

export class PluginArtifactSnapshot {
  private readonly digests = new Map<string, { digest: string; maxBytes: number }>()

  constructor(
    private readonly rootDir: string,
    private readonly label = 'plugin'
  ) {}

  async capture(path: string, maxBytes: number): Promise<string> {
    const text = await readContainedPluginArtifactText(this.rootDir, path, maxBytes)
    const digest = this.digest(text)
    const previous = this.digests.get(path)
    if (previous && previous.digest !== digest) {
      throw new Error(`${this.label} artifact changed during metadata admission`)
    }
    this.digests.set(path, { digest, maxBytes })
    return text
  }

  async read(path: string, maxBytes: number): Promise<string> {
    const text = await readContainedPluginArtifactText(this.rootDir, path, maxBytes)
    if (this.digests.get(path)?.digest !== this.digest(text)) {
      throw new Error(`${this.label} artifact changed since metadata admission`)
    }
    return text
  }

  async readCaptured(path: string): Promise<string> {
    const captured = this.digests.get(path)
    if (!captured) {
      throw new Error(`${this.label} artifact was not admitted`)
    }
    return this.read(path, captured.maxBytes)
  }
  hasCaptured(path: string): boolean {
    return this.digests.has(path)
  }

  async verifyAll(): Promise<void> {
    for (const path of this.digests.keys()) {
      await this.readCaptured(path)
    }
  }

  private digest(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex')
  }
}
