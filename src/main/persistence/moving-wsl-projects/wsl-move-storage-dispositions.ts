import {
  moveDisposition,
  notApplicableDisposition,
  type WslMoveFieldDisposition
} from './wsl-move-dispositions'

/**
 * Renderer modules that use localStorage, by what they keep. A new module fails the census test
 * until it is listed here.
 */
export const LOCAL_STORAGE_MODULE_DISPOSITIONS: Record<string, WslMoveFieldDisposition> = {
  'src/renderer/src/lib/quick-open-file-history.ts': {
    disposition: 'rewrite-desktop',
    item: 42
  },
  'src/renderer/src/components/editor/ipynb-kernel-store.ts': {
    disposition: 'rewrite-desktop',
    item: 43
  },
  'src/renderer/src/lib/structured-agent-session-launch-persistence.ts': {
    disposition: 'rewrite-desktop',
    item: 44,
    note: 'The payload fingerprint hashes the worktree, so a rewritten record re-derives it.'
  },
  'src/renderer/src/components/editor/file-view-preference-storage.ts': {
    disposition: 'rewrite-desktop',
    item: 72,
    note: 'CSV column widths and PDF scale, keyed by worktree id, runtime and file path.'
  },
  'src/renderer/src/components/native-chat/native-chat-composer-draft-journal.ts':
    notApplicableDisposition(45, 'Keyed by session id.'),
  'src/renderer/src/components/native-chat/native-chat-composer-draft-storage.ts':
    notApplicableDisposition(45, 'Keyed by session id.'),
  'src/renderer/src/components/native-chat/structured-agent-session-legacy-outbox.ts':
    notApplicableDisposition(45, 'Keyed by session id.'),
  'src/renderer/src/store/slices/worktrees/session/worktree-visit-recency.ts':
    notApplicableDisposition(
      32,
      'Web client only; the desktop keeps visit recency in the session.'
    ),
  ...Object.fromEntries(
    [
      'src/renderer/src/components/browser-pane/annotate/use-markup-draw-hint.ts',
      'src/renderer/src/components/feature-tips/FeatureTipsModal.tsx',
      'src/renderer/src/components/feature-wall/BrowserUseSkillSetupCard.tsx',
      'src/renderer/src/components/feature-wall/feature-wall-completion-persistence.ts',
      'src/renderer/src/components/floating-terminal/floating-terminal-panel-bounds.ts',
      'src/renderer/src/components/floating-terminal/floating-terminal-panel-render-probe.ts',
      'src/renderer/src/components/floating-terminal/floating-terminal-panel-test-harness.ts',
      'src/renderer/src/components/floating-terminal/floating-terminal-panel-view-state.ts',
      'src/renderer/src/components/floating-terminal/floating-terminal-trigger-position.ts',
      'src/renderer/src/components/floating-terminal/use-floating-terminal-orchestration-dismissal.ts',
      'src/renderer/src/components/github-project/column-widths.ts',
      'src/renderer/src/components/github-project/columns.ts',
      'src/renderer/src/components/github-project/roadmap-zoom-preference.ts',
      'src/renderer/src/components/landing-preflight-dismissal.ts',
      'src/renderer/src/components/linear-issue-view-storage.ts',
      'src/renderer/src/components/native-chat/NativeChatStructuredSession.test-harness.tsx',
      'src/renderer/src/components/onboarding/onboarding-feature-setup.ts',
      'src/renderer/src/components/pet/PetOverlay.tsx',
      'src/renderer/src/components/right-sidebar/ai-vault-view-options-persistence.ts',
      'src/renderer/src/components/right-sidebar/pr-comment-presentation.ts',
      'src/renderer/src/components/settings/BrowserUsePane.tsx',
      'src/renderer/src/components/settings/local-network-connection-history.ts',
      'src/renderer/src/components/sidebar/linear-agent-skill-runtime.ts',
      'src/renderer/src/components/sidebar/LinearAgentSkillSetupPrompt.tsx',
      'src/renderer/src/components/sidebar/mobile-sidebar-onboarding-badge.ts',
      'src/renderer/src/components/sidebar/SeveredTerminalDaemonBanner.tsx',
      'src/renderer/src/components/sidebar/SidebarToolbar.tsx',
      'src/renderer/src/components/terminal-pane/terminal-freeze-breadcrumbs.ts',
      'src/renderer/src/components/terminal-pane/terminal-render-desync-trigger.ts',
      'src/renderer/src/components/terminal-pane/terminal-startup-timing.ts',
      'src/renderer/src/components/UnexpectedSignoutCard.tsx',
      'src/renderer/src/lib/feature-education-telemetry.ts',
      'src/renderer/src/lib/orchestration-setup-state.ts',
      'src/renderer/src/lib/terminal-shortcut-capture-notification.tsx',
      'src/renderer/src/web/preload-api/web-keybindings-api.ts',
      'src/renderer/src/web/preload-api/web-onboarding-api.ts',
      'src/renderer/src/web/preload-api/web-preferences-store.ts',
      'src/renderer/src/web/preload-api/web-settings-api.ts',
      'src/renderer/src/web/preload-api/web-storage.ts',
      'src/renderer/src/web/preload-api/web-workspace-session-api.ts',
      'src/renderer/src/web/web-preload-api-test-harness.ts',
      'src/renderer/src/web/web-runtime-credential-source.ts',
      'src/renderer/src/web/web-runtime-environment.ts',
      'src/shared/default-global-settings.ts'
    ].map((path) => [
      path,
      notApplicableDisposition(62, 'Global preference or web-client storage.')
    ])
  )
}

/**
 * SQLite tables in the desktop's databases. Temporary migration tables (`*_new`, `*_v`) are
 * listed with the table they rebuild.
 */
export const SQLITE_TABLE_DISPOSITIONS: Record<string, WslMoveFieldDisposition> = {
  ...Object.fromEntries(
    [
      'agent_session_records',
      'agent_session_operations',
      'agent_session_tabs',
      'agent_session_store_meta',
      'agent_session_retired_claim_keys',
      'agent_session_command_receipts',
      'agent_session_attachment_claims',
      'agent_session_attachment_sweeps',
      'journal_imports',
      'journal_repairs',
      'journal_rows',
      'journal_sessions',
      'journal_set_aside',
      'queued_messages'
    ].map((table) => [
      table,
      moveDisposition(52, {
        newManifestSection: true,
        note: 'Native chat journal: scoped records move to the host, location rewritten.'
      })
    ])
  ),
  ...Object.fromEntries(
    [
      'worker_dispatches',
      'worker_terminal_resources',
      'worker_terminal_archives',
      'worker_terminal_archives_v',
      'remote_dispatch_attachments',
      'federated_dispatches',
      'federation_relay_items',
      'dispatch_contexts',
      'coordinator_runs',
      'run_coordinator_handles',
      'runs',
      'tasks',
      'decision_gates',
      'deliveries',
      'deliveries_new',
      'deliveries_v',
      'messages',
      'messages_new',
      'question_threads',
      'remote_questions',
      'mutation_receipts',
      'mutation_receipt_ledger',
      'mutation_caller_identities',
      'legacy_adoptions',
      'legacy_compatibility_principals',
      'legacy_mail_receipts',
      'legacy_operation_receipts',
      'attempt_observation_facts',
      'structured_pointer_operations',
      'won',
      'meta'
    ].map((table) => [
      table,
      {
        disposition: 'rewrite-desktop',
        item: 53,
        note: 'Orchestration history is rewritten in place; an active run or dispatch in scope blocks.'
      } as const
    ])
  ),
  profile_state_documents: {
    disposition: 'per-field',
    item: 1,
    note: 'Holds PersistedState itself.'
  },
  profile_state_meta: notApplicableDisposition(62),
  '${PROFILE_STATE_AUTOMATION_RUNS_TABLE}': moveDisposition(19, {
    note: 'PersistedState.automationRuns.'
  }),
  '${PROFILE_STATE_AUTOMATION_RUNS_META_TABLE}': notApplicableDisposition(
    19,
    'Bookkeeping for automationRuns.'
  ),
  '${IMPORT_SCOPE_TABLE}': notApplicableDisposition(58, 'Browser cookie import staging.'),
  sessions: notApplicableDisposition(57, 'AI Vault search index; rebuilt from transcripts.'),
  backfill_state: notApplicableDisposition(57, 'AI Vault search index; rebuilt from transcripts.'),
  files: notApplicableDisposition(57, 'AI Vault search index; rebuilt from transcripts.'),
  cookies: notApplicableDisposition(
    58,
    'Browser cookie import staging; the partition is bound, not copied.'
  ),
  // Read-only mirrors of third-party agent databases (OpenCode, Codex) used by tests and scanners.
  ...Object.fromEntries(
    ['message', 'part', 'project', 'session', 'session_message', 'session_v'].map((table) => [
      table,
      notApplicableDisposition(56, "A third-party agent's own database, inside the distro.")
    ])
  )
}
