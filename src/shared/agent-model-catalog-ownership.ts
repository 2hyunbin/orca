export function independentAgentModelCatalog(agent: string): boolean {
  return agent === 'claude' || agent === 'codex'
}
