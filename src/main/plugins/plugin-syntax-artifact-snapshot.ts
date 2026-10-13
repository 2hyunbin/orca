import { PluginArtifactSnapshot } from './plugin-artifact-snapshot'

export class PluginSyntaxArtifactSnapshot extends PluginArtifactSnapshot {
  constructor(rootDir: string) {
    super(rootDir, 'syntax')
  }
}
