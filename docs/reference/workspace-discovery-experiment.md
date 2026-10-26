# Workspace discovery experiments

Adding a project used to reveal every existing sibling worktree in the sidebar. The new handoff opens only the checkout the user picked and leaves the siblings behind a compact **N other workspaces found · Review** hint. Two experiments measure that change, one per population, so new and existing users can respond differently without diluting each other:

| Experiment                             | Population                                                | Control/treatment |
| -------------------------------------- | --------------------------------------------------------- | ----------------- |
| `workspace_discovery_new_user_v1`      | Profiles created by a build that includes this experiment | 20/80             |
| `workspace_discovery_existing_user_v1` | Profiles that existed before upgrading to such a build    | 20/80             |

| Arm         | Project-add handoff                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `control`   | Pre-experiment behavior: sets the project's external worktree visibility to show, revealing every sibling. |
| `treatment` | Imports only the selected checkout; hidden siblings surface through the hint.                              |

Each profile receives exactly one assignment, derived at load from a salted hash of its install ID (so it is reproducible from the transmitted `install_id`) and saved in `settings.telemetry` as `workspaceDiscoveryNewUserCohort` or `workspaceDiscoveryExistingUserCohort`. It survives restarts, settings changes and telemetry opt-out. "Existing" means the profile file existed before the upgrade, so it includes recent installs that have not added a project yet; segment by first `app_opened` if that matters.

Outside the handoff the arms are identical: both show the hint for hidden workspaces, and both can use **Manage workspaces** in the project menu. Dismissing the hint stops suggestions for that project until a visibility source is set to show. Folder projects have no external workspaces and never qualify. Projects added outside the add-project flow (for example via the CLI) skip the handoff and are not observed.

## Measurement

Every transmitted desktop event carries the install's experiment property. Existing consent, environment and official-build gates apply.

- `workspace_discovery_eligible`: emitted by the add-project handoff when the authoritative scan shows hidden sibling workspaces, before either arm changes visibility, so both arms qualify on identical evidence. `workspace_count` is the number of hidden siblings, capped at 50. It repeats for each qualifying project add; use each install's first event as time zero.
- `workspace_discovery_shown`: the hint mounted (`surface: suggestion`) or the manager finished its opening scan (`surface: manage`). This is a render observation, not a measure of attention.
- `workspace_discovery_action`: `reviewed`, `import_completed` or `dismissed`, with the surface and a capped count. Imports and dismissals are recorded only after they succeed.

Shown and action events are recorded at most once per surface and action per window session, so they measure adoption, not frequency. No workspace IDs, names, paths or host identifiers are transmitted.

Analyze each experiment separately and compare **rates** among distinct eligible installs:

1. Primary: `agent_prompt_sent` within 24 hours of eligibility for new users and within 7 days for existing users.
2. Retention: `app_opened` during days 1–7 after eligibility, with complete follow-up for both arms.
3. Diagnostics: hint review, successful import and dismissal in treatment; management use in both arms.

Events before eligibility do not count as experiment outcomes. Report sample sizes and uncertainty for each population; the 20% control arm sets how quickly small effects resolve. Non-consenting installs are outside the measured sample.
