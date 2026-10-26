import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SLACK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['slack', 'reply'],
    hidden: true,
    summary: 'Reply in the Slack thread that started this agent',
    usage: 'orca slack reply --text <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'text'],
    notes: [
      'Run it from an agent a Slack message started. Orca posts the text to that thread through Orca Cloud; this machine needs no Slack token.',
      'Experimental: needs the experimentalConnectors setting and a desktop signed in to Orca.'
    ]
  }
]
