import type { ProcessedAgentStatusChunk } from '../../../../shared/agent-status-osc'
import { createAgentStatusOscProcessor } from '../../../../shared/agent-status-osc'
import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function processAgentStatusOscForPty(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  data: string
): ProcessedAgentStatusChunk {
  let processor = output.agentStatusOscProcessorsByPtyId.get(ptyId)
  if (!processor) {
    processor = createAgentStatusOscProcessor()
    output.agentStatusOscProcessorsByPtyId.set(ptyId, processor)
  }
  return processor(data)
}
