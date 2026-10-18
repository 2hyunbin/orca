import { z } from 'zod'
import { getSettingsFocusedExecutionHostId } from '../../../src/shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../src/shared/host-setting-overrides'
import { SidebarInputsReadResultSchema } from '../../../src/shared/sidebar-list/sidebar-inputs-feed-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import type { RpcResponse } from '../transport/types'

// The host's sidebar feed (src/main/runtime/sidebar-inputs/), read only by a page built with
// ORCA_SIDEBAR_INPUTS=main. A host without it answers method_not_found, or forbidden from an
// older mobile allowlist; either means this page is newer than the host.

export const sidebarInputsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'sidebarInputs.read-or-skip',
    method: 'sidebarInputs.read',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sidebar-inputs', SidebarInputsReadResultSchema)
  })
)

export const sidebarRepoIconsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'sidebarInputs.repoIcons-or-skip',
    method: 'sidebarInputs.repoIcons',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'repo-icons',
      z.object({ icons: z.array(z.object({ id: z.string(), dataUrl: z.string().nullable() })) })
    )
  })
)

export const setCollapsedWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.setCollapsed-or-skip',
    method: 'ui.setCollapsed',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'collapse-written',
      z.object({ collapsed: z.boolean(), applied: z.boolean() })
    )
  })
)

const hostSidebarFocusSchema = z
  .object({
    settings: z
      .object({
        activeRuntimeEnvironmentId: z.string().nullable().optional().catch(null),
        hostSettingOverrides: z
          .record(z.string(), z.object({ displayLabel: z.string().optional() }).catch({}))
          .optional()
          .catch({})
      })
      .catch({})
  })
  .transform(({ settings }) => ({
    focusedHostId: getSettingsFocusedExecutionHostId(settings),
    hostLabelOverrides: getHostDisplayLabelOverrides(settings)
  }))

/**
 * The desktop settings a feed-built list reads beside the shared view: the host its sidebar has
 * focused, where rows that name no owner land, and its own names for its hosts. Read off the
 * settings.get reply the list settings already come from.
 */
export const hostSidebarFocusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.host-sidebar-focus-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('host-sidebar-focus', hostSidebarFocusSchema)
  })
)

/** A reply either answers, says the host lacks the method, or failed (retry on the next trigger). */
export type HostMethodReply<Value> =
  | { kind: 'answered'; value: Value }
  | { kind: 'unavailable' }
  | { kind: 'failed' }

export function readHostMethodReply<Value>(
  reply: RpcResponse,
  interpret: (reply: RpcResponse) => { accepted: true; value: Value } | { accepted: false }
): HostMethodReply<Value> {
  if (!reply.ok) {
    return isMobileMethodUnavailableError(reply.error.code, reply.error.message)
      ? { kind: 'unavailable' }
      : { kind: 'failed' }
  }
  try {
    const verdict = interpret(reply)
    return verdict.accepted ? { kind: 'answered', value: verdict.value } : { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}
