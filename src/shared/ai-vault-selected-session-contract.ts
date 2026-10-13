import { hasUnsafeProviderSessionIdChars } from './agent-session-resume'
import { z } from 'zod'
import { AI_VAULT_AGENTS } from './ai-vault-types'
import {
  isAgentSessionAccountHome,
  type AgentSessionAccountHome
} from './agent-session-account-home'
import { normalizeExecutionHostId } from './execution-host'
const id = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !hasUnsafeProviderSessionIdChars(value))
export const SelectedCliSourceSchema = z.strictObject({ paneKey: id, workspaceId: id })
export const SelectedSessionSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chat'), sessionId: id, workspaceId: id }),
  z.strictObject({
    kind: z.literal('cli'),
    agent: z.enum(['claude', 'codex']),
    providerSessionId: id,
    paneKey: id,
    workspaceId: id
  })
])
export const SelectedSessionParams = z.strictObject({
  source: SelectedSessionSourceSchema,
  executionHostId: z.string().optional()
})
export const SelectedSessionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('missing') }),
  z.object({ status: z.literal('cancelled') }),
  z.object({
    status: z.literal('ready'),
    session: z.object({
      agent: z.enum(AI_VAULT_AGENTS),
      sessionId: id,
      executionHostId: z.string().transform((value, ctx) => {
        const host = normalizeExecutionHostId(value)
        if (host) {
          return host
        }
        ctx.addIssue({ code: 'custom', message: 'Invalid conversation host' })
        return z.NEVER
      }),
      executionHostPlatform: z
        .enum([
          'aix',
          'android',
          'darwin',
          'freebsd',
          'haiku',
          'linux',
          'openbsd',
          'sunos',
          'win32',
          'cygwin',
          'netbsd'
        ])
        .nullable()
        .optional(),
      filePath: z.string(),
      cwd: z.string().nullable(),
      codexHome: z.string().nullable(),
      title: z.string(),
      branch: z.string().nullable(),
      messageCount: z.number().nonnegative(),
      previewMessages: z.array(
        z.object({
          role: z.enum(['user', 'assistant', 'system', 'tool', 'unknown']),
          text: z.string(),
          timestamp: z.string().nullable()
        })
      ),
      structuredSession: z.object({ sessionId: id, workspaceId: id }).optional(),
      accountHome: z.custom<AgentSessionAccountHome>(isAgentSessionAccountHome).optional(),
      selectedSource: SelectedCliSourceSchema.optional()
    })
  })
])
