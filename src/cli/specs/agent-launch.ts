import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_LAUNCH_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'launch'],
    summary: 'Start an agent in an existing worktree, as a chat or a terminal per your settings',
    usage:
      'orca agent launch --agent <id> [--worktree <selector>] [--prompt <text>] [--model <id>] [--effort <level>] [--focus] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'worktree', 'prompt', 'model', 'effort', 'focus'],
    notes: [
      'Starts the agent the way a new agent tab does: as a chat when your Chat UI setting is on and the agent and host support it, otherwise as a terminal. The result says which (`outcome.kind`) and why (`receipt.detail`).',
      '--worktree defaults to the worktree containing the current directory. For a new checkout with its agent, use `orca worktree create --agent`.',
      '--model takes a provider model id and --effort a reasoning effort for that model; --effort requires --model. They apply to either surface.',
      'The tab opens without switching focus; pass --focus to switch to it.'
    ],
    examples: [
      'orca agent launch --agent codex --json',
      'orca agent launch --agent codex --model gpt-6-astra --effort high --prompt "Write the design doc" --json',
      'orca agent launch --agent claude --worktree path:/projects/myapp --focus'
    ]
  }
]
