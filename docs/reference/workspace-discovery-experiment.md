# Workspace discovery experiment

`workspace_discovery_v1` compares automatic sidebar suggestions for hidden, external workspaces:

| Variant     | Fresh installs | Behavior                              |
| ----------- | -------------- | ------------------------------------- |
| `treatment` | 90%            | Show workspace discovery suggestions. |
| `control`   | 10%            | Hide automatic suggestions.           |

Assignment is independent of the onboarding language experiment and saved as `settings.telemetry.workspaceDiscoveryCohort` before first launch. It survives restarts, settings changes and telemetry opt-out. Existing profiles are excluded and keep suggestions. Both groups can use **Manage workspaces** in the project menu; the experiment changes suggestions, not workspace visibility or imports. Folder projects have no external-workspace discovery and never qualify. The same client assignment applies to local and remote projects. Mobile has no matching suggestion surface and does not enroll users through this flow.

Suggestions are compact sidebar hints. **Review** and the project menu open the same workspace manager, independently of sidebar expansion, filters, and scrolling. The manager scans its project owner, supports selecting hidden workspaces in a searchable virtualized list, and keeps source controls under **Visibility settings**. Dismissing the hint suppresses suggestions without changing visibility rules or imported paths. Onboarding opens the selected checkout without requiring an import decision.

## Measurement

All transmitted desktop events for enrolled installs carry the frozen `workspace_discovery_v1` property. Existing consent, environment and official-build gates apply. Discovery events are rejected for unenrolled installs. These observations do not write to disk.

- `workspace_discovery_eligible`: emitted in both groups when an authoritative workspace scan first produces an automatic suggestion candidate, before applying the holdout. Deduplicated across windows and sidebar mounts per app session; a rejected observation can retry after settings or consent changes. Count distinct `install_id` values, not event totals; restarts can repeat it. Opening management alone does not establish eligibility.
- `workspace_discovery_shown`: a suggestion mounted or the manager completed its initial scan. This is a render observation, not a measure of attention. `surface` distinguishes `suggestion` from `manage`; `workspace_count` is capped at 50.
- `workspace_discovery_action`: `reviewed`, `import_completed` or `dismissed`, with the same surface and capped count. Imports and dismissals are recorded only after success; import counts describe selected workspaces. No workspace IDs, names, paths or host identifiers are transmitted.

Each surface observation and action/surface pair is recorded only once per app session, across all windows. Together with eligibility this allows at most nine discovery events per session; duplicates are dropped before consuming the shared telemetry budget or reading settings. These events measure adoption and conversion, not action frequency or total workspace imports. Automatic suggestions wait for settings hydration, so a control user cannot see a suggestion before its assignment loads.

Suppressing a suggestion preserves its project header even when workspace filters hide every workspace, so **Manage workspaces** remains reachable in both groups. It does not change stored workspace visibility, selected imports, host routing, or folder workspace behavior.

Use each install's first eligibility event as time zero. Compare conversion **rates** by variant among distinct eligible installs, rather than raw totals from the unequal groups:

1. Primary: send an `agent_prompt_sent` within 24 hours of eligibility.
2. Retention: `app_opened` during days 1–7 after eligibility, with complete follow-up for both groups.
3. Diagnostics: suggestion review, successful import, dismissal, and use of management to import without a suggestion.

Events before eligibility do not count as experiment outcomes. Keep management events in the control analysis: finding workspaces without a suggestion is part of its experience. Onboarding completion may precede sidebar eligibility, so it is not a post-exposure conversion metric. Report sample sizes and uncertainty; the 10% holdout will take longer to resolve small effects. Profiles without the cohort property and non-consenting installs are outside the measured sample.
