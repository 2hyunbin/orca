// A long text paste into a structured chat is saved as a file the agent reads, as a dropped file
// is: in Orca's paste folder here, or in the chat's attachment store on its paired server.

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import {
  agentSessionPastedTextName,
  type AgentSessionAttachmentClipboardTarget
} from '../../shared/agent-session-attachments'
import { assertClipboardTextWithinLimit } from '../../shared/clipboard-text'
import { uploadPasteToAgentSessionAttachments } from '../ipc/agent-session-attachment-upload'
import { nativeChatPasteFolder } from './native-chat-paste-files'

export type SavePastedTextAsFileArgs = {
  text: string
  /** With `agentSessionAttachment`: the paired server whose chat stores the file. */
  runtimeEnvironmentId?: string | null
  agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
}

export async function savePastedTextAsFile(args: SavePastedTextAsFileArgs): Promise<string> {
  if (typeof args?.text !== 'string') {
    throw new Error('Pasted text is missing.')
  }
  assertClipboardTextWithinLimit(args.text)
  const buffer = Buffer.from(args.text, 'utf8')
  const name = agentSessionPastedTextName(Date.now(), randomUUID())
  const runtimeEnvironmentId = args.runtimeEnvironmentId?.trim()
  if (runtimeEnvironmentId && args.agentSessionAttachment) {
    return uploadPasteToAgentSessionAttachments(
      args.agentSessionAttachment,
      runtimeEnvironmentId,
      app.getPath('userData'),
      buffer,
      name
    )
  }
  const folder = nativeChatPasteFolder()
  await fs.mkdir(folder, { recursive: true })
  const filePath = path.join(folder, name)
  await fs.writeFile(filePath, buffer)
  return filePath
}
