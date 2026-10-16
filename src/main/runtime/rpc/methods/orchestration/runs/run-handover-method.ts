import { defineMethod } from '../../../core'
import { RunHandoverParams } from '../../../../../../shared/rpc-contract/orchestration-runs-params'
import { resolveOrchestrationParty } from '../../../../orchestration/orchestration-party'
import { issueRunHandover } from '../../../../orchestration/db/runs/run-handover'
import { resolveOrchestrationCaller } from './run-scope'
import { resolveRunCallerKey } from './run-caller-key'

export const RUN_HANDOVER_METHOD = defineMethod({
  name: 'orchestration.runHandover',
  permission: 'workspace',
  params: RunHandoverParams,
  handler: (
    params,
    { runtime, orchestrationCaller, orchestrationCompatibilityEvidence, recordMutationReceipt }
  ) => {
    const caller = resolveOrchestrationCaller(runtime, {
      callerTerminalHandle: params.from,
      callerSession: orchestrationCaller,
      callerEvidence: orchestrationCompatibilityEvidence,
      requireStablePane: true
    })
    const db = runtime.getOrchestrationDb()
    const target = params.toTask
      ? { taskId: params.toTask }
      : {
          caller: resolveRunCallerKey(runtime, resolveOrchestrationParty(params.to ?? '', db))
        }
    return issueRunHandover(db, {
      runId: params.id,
      caller: resolveRunCallerKey(runtime, caller),
      target,
      recordReceipt: recordMutationReceipt
    })
  }
})
