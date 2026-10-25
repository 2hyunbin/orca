import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** Mirrors the titlebar extension's dialog tracking so both agree on when the wait ends. */
export function getPiAgentStatusUiPromptHandlerSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    "  onStatus('ui_prompt_start', () => {",
    '    // Idle utility dialogs are not agent work; do not create a completion boundary for them.',
    '    if (isOmpRuntime() || !piUiState.turnInFlight) return',
    '    piUiState.depth++',
    '    if (piUiState.depth > 1) return',
    "    post('ui_prompt_start')",
    '  })',
    '',
    "  onStatus('ui_prompt_end', (_event, ctx) => {",
    '    if (isOmpRuntime() || piUiState.depth === 0) return',
    '    piUiState.depth--',
    '    if (piUiState.depth > 0) return',
    '    // Session-switching dialogs can invalidate ctx.isIdle; trust local no-turn state when no later end event can correct it.',
    '    let isIdle = !piUiState.turnInFlight',
    '    try {',
    "      if (!isIdle && typeof ctx?.isIdle === 'function') isIdle = ctx.isIdle() === true",
    '    } catch {',
    '      // Invalidated runners cannot answer; retain local state.',
    '    }',
    '    // Pi can be idle while its children still own the run.',
    '    isIdle &&= !isHeldByChildren()',
    "    post('ui_prompt_end', { is_idle: isIdle })",
    '  })',
    ''
  ]
}
