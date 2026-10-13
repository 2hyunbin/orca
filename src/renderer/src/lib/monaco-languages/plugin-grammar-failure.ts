export type PluginGrammarFailureReason = 'load' | 'size' | 'capacity' | 'budget' | 'worker'

export type PluginSyntaxFailure = {
  key: string
  revision: string
  reason: PluginGrammarFailureReason
}

export class PluginGrammarFailure extends Error {
  constructor(readonly reason: PluginGrammarFailureReason) {
    super(`Plugin highlighting unavailable: ${reason}`)
    this.name = 'PluginGrammarFailure'
  }
}
