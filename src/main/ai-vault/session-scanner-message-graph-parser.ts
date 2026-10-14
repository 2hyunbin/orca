import { selectedTranscriptLines, type SelectedTranscriptRead } from './selected-transcript-lines'
import { foldOmpTranscriptTitle, type OmpTranscriptTitle } from './session-scanner-omp-title'
import {
  remoteSessionContentLines,
  type RemoteSessionContent
} from './remote-session-content-lines'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { withOmpSubagentTranscriptCount } from './session-scanner-omp-subagent-transcripts'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  accumulatorSessionIdentity,
  cloneSessionAccumulator,
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import {
  asRecord,
  extractMessageText,
  extractString,
  parseJsonObject,
  tokenTotal
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

// Agents whose transcripts are append-only message-graph JSONL (session +
// model_change + message records). OMP and Prime Agent are Pi forks and
// share the format.
export type MessageGraphAgent = 'openclaw' | 'pi' | 'omp' | 'prime-agent'

export async function parseMessageGraphSessionFile(
  agent: MessageGraphAgent,
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  selectedRead?: SelectedTranscriptRead
): Promise<AiVaultSession | null> {
  if (selectedRead) {
    return parseMessageGraphSessionLines({
      agent,
      file,
      lines: selectedTranscriptLines(file.path, selectedRead),
      platform,
      messages,
      selectedRead
    })
  }
  const input = openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan')
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    return await parseMessageGraphSessionLines({ agent, file, lines, platform, messages })
  } finally {
    // readline.close() leaves the underlying stream open; destroy it so a
    // mid-parse throw cannot leak the gated transcript handle.
    lines.close()
    input.destroy()
  }
}

export async function parseMessageGraphSessionContent(
  agent: MessageGraphAgent,
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseMessageGraphSessionLines({
    agent,
    file,
    lines: remoteSessionContentLines(content, signal),
    platform,
    options
  })
}

type MessageGraphParseState = {
  accumulator: SessionAccumulator
  ompTitle: OmpTranscriptTitle | null
}

function consumeMessageGraphRecordLine(state: MessageGraphParseState, line: string): void {
  const { accumulator } = state
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  if (accumulator.agent === 'omp') {
    state.ompTitle = foldOmpTranscriptTitle(state.ompTitle, record)
    if (state.ompTitle) {
      accumulator.title = state.ompTitle.title
    }
  }
  if (record.type === 'session') {
    const sessionId = extractString(record.id)
    if (sessionId) {
      accumulator.sessionId = sessionId
    }
    accumulator.cwd = extractString(record.cwd) ?? accumulator.cwd
    return
  }
  if (record.type === 'model_change') {
    // Pi writes `modelId`; OMP writes `model`. Prefer either so an in-progress
    // session shows its model before the first assistant reply lands.
    accumulator.model =
      extractString(record.modelId) ?? extractString(record.model) ?? accumulator.model
    return
  }
  if (record.type !== 'message') {
    return
  }
  const message = asRecord(record.message)
  const role = extractString(message?.role)
  if (role === 'user' || role === 'assistant') {
    accumulator.messageCount++
    if (role === 'user') {
      if (accumulator.agent === 'omp') {
        accumulator.fallbackTitle ??= extractMessageText(message)
      } else {
        accumulator.title ??= extractMessageText(message)
      }
    } else {
      accumulator.model = extractString(message?.model) ?? accumulator.model
      accumulator.totalTokens += tokenTotal(message?.usage)
    }
    addPreviewContent(accumulator, role, message?.content, record.timestamp)
  }
}

export function createMessageGraphSessionResumeState(
  agent: MessageGraphAgent,
  file: FileWithMtime,
  messages?: TranscriptMessageSink,
  includeSubagents = true
): ResumableSessionParseState {
  const state = createMessageGraphResumeState({
    accumulator: createAccumulator({
      agent,
      file,
      sessionId: sessionIdFromFileName(file.path),
      messages
    }),
    ompTitle: null
  })
  // Why: only OMP materializes task-subagent transcripts beside its sessions
  // (in the same-named artifact dir); the row UI shows the count without
  // expanding details. Pi/OpenClaw/Prime Agent have no such layout — skip the readdir.
  return agent === 'omp' && includeSubagents
    ? withOmpSubagentTranscriptCount(state, file.path)
    : state
}

function createMessageGraphResumeState(state: MessageGraphParseState): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeMessageGraphRecordLine(state, line),
    identity: () => accumulatorSessionIdentity(state.accumulator),
    clone: () =>
      createMessageGraphResumeState({
        accumulator: cloneSessionAccumulator(state.accumulator),
        ompTitle: state.ompTitle
      }),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options) =>
      finalizeSession(cloneSessionAccumulator(state.accumulator), platform, options)
  }
}

async function parseMessageGraphSessionLines(args: {
  agent: MessageGraphAgent
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
  messages?: TranscriptMessageSink
  selectedRead?: SelectedTranscriptRead
}): Promise<AiVaultSession | null> {
  const state = createMessageGraphSessionResumeState(
    args.agent,
    args.file,
    args.messages,
    !args.selectedRead
  )
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}
