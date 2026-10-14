import { readSelectedSessionInBackground } from '../ai-vault/selected-session-reader-client'
import { homedir } from 'node:os'
import { resolveOmpSessionsDir } from '../ai-vault/omp-session-root'
import { directoryTranscriptImport } from '../native-chat/structured-agent-cli-conversations'
import { findOmpSessionByCwd } from './omp-session-cwd-lookup'

export const OMP_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  transcriptRoot: ompAccountSessionsRoot,
  readSelectedSession: ({ transcriptPath, signal }) =>
    readSelectedSessionInBackground(
      { agent: 'omp', filePath: transcriptPath, codexHome: null },
      signal
    ),
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  // Where OMP itself keeps the account's sessions, which is not always under it (XDG_DATA_HOME).
  findTranscript: async ({
    providerSessionId,
    accountHomePath,
    launchEnv,
    workspaceCwd,
    selected
  }) => {
    const homeDir =
      (process.platform === 'win32' ? launchEnv.USERPROFILE : launchEnv.HOME) || homedir()
    const sessionsDir = ompAccountSessionsRoot({ launchEnv, accountHomePath })
    return sessionsDir
      ? findOmpSessionByCwd({
          sessionsDir,
          sessionId: providerSessionId,
          cwd: workspaceCwd,
          homeDir,
          env: launchEnv,
          signal: selected?.signal
        })
      : null
  }
})

function ompAccountSessionsRoot({
  launchEnv,
  accountHomePath
}: {
  launchEnv: NodeJS.ProcessEnv
  accountHomePath: string
}) {
  const homeDir =
    (process.platform === 'win32' ? launchEnv.USERPROFILE : launchEnv.HOME) || homedir()
  return resolveOmpSessionsDir({
    env: { ...launchEnv, PI_CODING_AGENT_DIR: accountHomePath },
    homeDir
  })
}
