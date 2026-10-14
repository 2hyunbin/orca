import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import type { StructuredAgentSessionAdoption } from './structured-agent-session-history-adoption'
import type { AiVaultSessionResumePreparation } from '../../shared/ai-vault-resume-preparation'
import {
  isLegacySharedCodexHome,
  isPerAccountManagedCodexHome
} from '../../shared/ai-vault-resume-preparation'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { admitTranscriptPath } from './transcript-path-admission'

/** The same host preparation decides credentials for both lookup-based and selected adoption. */
export async function prepareSelectedCodexAdoption(
  source: StructuredAgentSessionAdoption,
  providerSessionId: string,
  prepare: AiVaultSessionResumePreparation | undefined,
  signal: AbortSignal
): Promise<StructuredAgentSessionAdoption> {
  if (
    !prepare ||
    !(
      isLegacySharedCodexHome(source.accountHomePath) ||
      isPerAccountManagedCodexHome(source.accountHomePath)
    )
  ) {
    return source
  }
  const result = await prepare({
    agent: 'codex',
    sessionId: providerSessionId,
    filePath: source.transcriptPath,
    codexHome: source.accountHomePath,
    executionHostId: LOCAL_EXECUTION_HOST_ID
  })
  signal.throwIfAborted()
  const home = result.useRealCodexHome ? getSystemCodexHomePath() : result.substituteCodexHome
  if (!home || home === source.accountHomePath) {
    return source
  }
  const admitted = await admitTranscriptPath(
    join(source.accountHomePath, 'sessions'),
    source.transcriptPath
  )
  if (!admitted?.relativePath) {
    throw new Error('The prepared conversation path could not be verified.')
  }
  const transcriptPath = join(home, 'sessions', admitted.relativePath)
  if (!(await stat(transcriptPath)).isFile()) {
    throw new Error('The prepared conversation history is unavailable.')
  }
  signal.throwIfAborted()
  return { accountHomePath: home, transcriptPath }
}
