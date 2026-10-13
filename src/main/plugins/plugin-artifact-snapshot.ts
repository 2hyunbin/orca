import { createHash } from 'node:crypto'
import { readContainedPluginArtifactText } from './plugin-artifact-file-reader'

export class PluginArtifactSnapshot {
  private readonly digests = new Map<string, string>()

  constructor(
    private readonly rootDir: string,
    private readonly label = 'plugin'
  ) {}

  async capture(path: string, maxBytes: number): Promise<string> {
    const text = await readContainedPluginArtifactText(this.rootDir, path, maxBytes)
    const digest = this.digest(text)
    const previous = this.digests.get(path)
    if (previous && previous !== digest) {
      throw new Error(`${this.label} artifact changed during metadata admission`)
    }
    this.digests.set(path, digest)
    return text
  }

  async read(path: string, maxBytes: number): Promise<string> {
    const text = await readContainedPluginArtifactText(this.rootDir, path, maxBytes)
    if (this.digests.get(path) !== this.digest(text)) {
      throw new Error(`${this.label} artifact changed since metadata admission`)
    }
    return text
  }

  private digest(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex')
  }
}
