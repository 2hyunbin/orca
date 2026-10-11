import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const PAIRING_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['pairing', 'create'],
    summary: 'Mint a single-use pairing link for another device to pair with this Orca host',
    usage: 'orca pairing create [--ttl <duration>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ttl'],
    notes: [
      'Prints only the link on stdout, so it can be piped straight to the device that redeems it. The secret is in the link fragment, never in a query string; it is never logged.',
      'Anyone holding the link can pair until it is redeemed or expires: deliver it over a channel you trust.',
      '--ttl defaults to 30m and cannot exceed 1h (for example 15m, 1h, 900s).',
      'Runs against the Orca runtime on this machine; it cannot mint on a remote environment.'
    ],
    examples: ['orca pairing create', 'orca pairing create --ttl 15m --json']
  },
  {
    path: ['pairing', 'list'],
    summary: 'List outstanding pairing links (never their secrets)',
    usage: 'orca pairing list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['pairing', 'revoke'],
    destructive: true,
    summary: 'Revoke an outstanding pairing link by the id `orca pairing list` shows',
    usage: 'orca pairing revoke <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id']
  }
]
