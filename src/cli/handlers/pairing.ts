import type { CommandHandler, HandlerContext } from '../dispatch'
import { getRequiredStringFlag, getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { RuntimeClientError } from '../runtime/types'
import {
  CREATE_PAIRING_TICKET_METHOD,
  LIST_PAIRING_TICKETS_METHOD,
  REVOKE_PAIRING_TICKET_METHOD
} from '../../shared/pairing-ticket-capability'
import {
  parsePairingTicketTtl,
  type CreatePairingTicketResult,
  type ListPairingTicketsResult,
  type RevokePairingTicketResult
} from '../../shared/pairing-ticket-contract'

function rejectRemote(ctx: HandlerContext, command: string): void {
  rejectRemoteSelectionFlags(
    ctx.flags,
    `\`${command}\`. Run it on the host the device should pair with.`
  )
}

export function formatPairingTicketList(result: ListPairingTicketsResult): string {
  if (result.tickets.length === 0) {
    return 'No outstanding pairing links.'
  }
  return result.tickets
    .map(
      (ticket) =>
        `${ticket.ticketId}  ${ticket.scope}  ${ticket.issuedVia}  ${ticket.state}  expires ${new Date(ticket.expiresAt).toISOString()}`
    )
    .join('\n')
}

export const PAIRING_HANDLERS: Record<string, CommandHandler> = {
  'pairing create': async (ctx) => {
    rejectRemote(ctx, 'orca pairing create')
    const ttlFlag = getOptionalStringFlag(ctx.flags, 'ttl')
    let ttlMs: number | undefined
    try {
      ttlMs = ttlFlag === undefined ? undefined : parsePairingTicketTtl(ttlFlag)
    } catch (error) {
      throw new RuntimeClientError(
        'invalid_argument',
        error instanceof Error ? error.message : String(error)
      )
    }
    const result = await ctx.client.call<CreatePairingTicketResult>(
      CREATE_PAIRING_TICKET_METHOD,
      ttlMs !== undefined ? { ttlMs } : {}
    )
    if (!ctx.json) {
      // Why stderr: stdout carries only the link, so piping it delivers nothing else.
      console.error(
        `Single-use pairing link ${result.result.ticketId}; expires ${new Date(result.result.expiresAt).toISOString()}.`
      )
    }
    printResult(result, ctx.json, (ticket) => ticket.link)
  },
  'pairing list': async (ctx) => {
    rejectRemote(ctx, 'orca pairing list')
    const result = await ctx.client.call<ListPairingTicketsResult>(LIST_PAIRING_TICKETS_METHOD)
    printResult(result, ctx.json, formatPairingTicketList)
  },
  'pairing revoke': async (ctx) => {
    rejectRemote(ctx, 'orca pairing revoke')
    const ticketId = getRequiredStringFlag(ctx.flags, 'id')
    const result = await ctx.client.call<RevokePairingTicketResult>(REVOKE_PAIRING_TICKET_METHOD, {
      ticketId
    })
    if (!result.result.revoked) {
      throw new RuntimeClientError(
        'not_found',
        `No outstanding pairing link has id ${ticketId}. Run \`orca pairing list\`.`
      )
    }
    printResult(result, ctx.json, () => `Revoked pairing link ${ticketId}.`)
  }
}
