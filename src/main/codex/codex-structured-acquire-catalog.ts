import type {
  CodexSessionCatalogAccess,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredLaunch
} from './codex-structured-session-state'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'

export function codexAcquireCatalogAccess(
  deps: Pick<CodexStructuredSessionAdapterDeps, 'modelCatalog' | 'readModelCatalog'>,
  launch: Pick<CodexStructuredLaunch, 'codexHome'>,
  sessionId?: string
): CodexSessionCatalogAccess | undefined {
  const access = agentModelCatalogSessionAccess(
    deps.modelCatalog,
    CODEX_STRUCTURED_AGENT,
    launch.codexHome
  )
  return access && deps.readModelCatalog && sessionId
    ? { ...access, read: () => deps.readModelCatalog?.(sessionId) ?? null }
    : access
}
