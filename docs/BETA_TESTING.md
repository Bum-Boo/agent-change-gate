# External beta protocol

This protocol is for testing whether people repeatedly value Agent Change Gate's review-before-write workflow without weakening its safety boundary or adding client-side telemetry.

Current boundary as of 2026-08-13:

- `0.2.0` is the latest public GitHub prerelease and supports only the single-note flow;
- `0.3.0` and Vault Batch Review are unreleased development work;
- one isolated Windows + WSL Hermes Lab run passed one Ask turn and one edit proposal → complete diff → explicit apply flow;
- the batch GUI, real-model multi-note flow, rollback, and recovery remain manually unverified;
- the plugin is not listed in Obsidian Community Plugins, no `0.3.x` BRAT beta exists, and funding is not enabled.

See [COMPATIBILITY.md](COMPATIBILITY.md) for the evidence matrix, [SECURITY.md](../SECURITY.md) for vulnerability reporting, and [PRIVACY.md](../PRIVACY.md) for local data handling.

## Release entry gate

Do not tell testers to install a development branch. Begin a `0.3.x` BRAT beta only after all of the following are true:

- a matching GitHub prerelease tag and `manifest.json` version exist;
- `main.js`, `manifest.json`, and `styles.css` are attached as individual release assets;
- the packaged archive and individual assets have been downloaded and checked;
- CI, release validation, and an independent built-`main.js` review are green;
- the manual single-note matrix includes Ask, propose, complete diff, apply, stale rejection, cancellation, and guarded undo;
- the manual batch safety matrix below is complete in an isolated disposable vault before any external tester is invited to use batch mode.

Until this gate passes, testers may evaluate the published `0.2.0` single-note prerelease only by its documented manual-install path. A Git branch URL is not a beta release.

## Tester qualification and consent

Recruit 30 people who are not the maintainer and who already use Obsidian desktop plus Hermes or another ACP-compatible local agent. Before participation, each tester must agree to:

- use a disposable vault or a verified copy, never the only copy of important notes;
- exclude credentials, private client material, medical records, and other sensitive content;
- understand that the external agent is not OS-sandboxed and may contact its configured provider;
- inspect every diff and keep normal backups;
- report only the metadata template below, never prompts, note text, model output, secrets, absolute paths, or launch commands.

No tester should be pressured to enable batch mode. Batch participation is conditional on the manual batch gate and remains opt-in and experimental.

## Four-week, 30-person funnel

Counts are unique qualified testers, not downloads or GitHub stars. A tester is counted only after returning the metadata-only report.

| Week | Activity | Exit threshold |
| --- | --- | --- |
| 1 — Recruit and install | Recruit 30 qualified testers; provide the checked release, a five-minute quick start, the Lab screenshots, and safety boundary. | 30 consented recruits; at least 20 verified installs. |
| 2 — Single-note activation | Each installed tester runs agent detection, one Ask, one proposed edit, reviews a complete diff, applies or deliberately discards it, and tests stale rejection in a disposable note. | At least 15 activated without live maintainer intervention; zero plugin-mediated out-of-scope writes or unrecoverable losses. |
| 3 — Repeat and conditional batch | Measure return use. If and only if the manual batch safety gate is complete, invite a smaller cohort to run 2–5 note batches in disposable copies and review every draft. | At least 8 week-two returners. Conditional batch target: 10 completed runs; otherwise record batch as blocked, not failed or zero. |
| 4 — Retention and value | Re-run a real recurring note task and collect the reason for continued use plus a non-binding supporter price response. | At least 5 week-four returners and at least 3 testers who name the review gate—not generic chat—as the reason to keep using it. |

Supporting activation targets:

- median time from enabled plugin to successful Ask at or below ten minutes;
- at least 12 of the 15 activated testers complete a reviewed edit without live help;
- every intentionally stale proposal in the reported cohort is refused;
- at least one tester uses an ACP implementation other than the maintainer-verified Hermes configuration before a universal compatibility claim is considered.

The funnel is not proof of market size. It is a minimum signal for deciding whether to continue, improve onboarding, or keep the project as an unsupported experiment.

## Safety stop gates

Stop new beta invitations immediately if any of these occurs:

- a plugin-mediated write reaches a file or scope the host did not select;
- a write happens without the documented review and confirmation path;
- a stale proposal is applied;
- later user changes are overwritten during undo, rollback, or recovery;
- a credential, prompt, note body, model response, absolute path, or launch command appears in a report or user-facing diagnostic;
- an unresolved recovery state permits another plugin write;
- a reproducible high-severity boundary or data-loss issue remains open.

When stopped, preserve the test vault, stop collecting ordinary public reports, use the private process in [SECURITY.md](../SECURITY.md), fix and independently review the failure, publish a new prerelease, and repeat the affected matrix row. Do not describe a blocked cohort as successful.

## Manual verification matrix

Record `Pass`, `Fail`, `Blocked`, or `Not run`; never infer a pass from automated tests. Keep exact versions and package or commit identity. The first row is the only completed real-model evidence today, and its missing exact build identity limits reproducibility.

| Plugin build | Host / transport | Agent | Obsidian | Initialize | Ask | Propose → complete diff → apply | Stale block | Cancel | Guarded single undo | Batch review/apply | Batch partial failure/recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Unreleased 0.3 working tree; exact commit/package identity not recorded | Windows + WSL stdio | Hermes 0.20.0 | 1.13.6 | Pass | Pass (1) | Pass (1) | Not run | Not run | Not run | Not run | Not run |
| Exact release asset or commit required | Windows native | Hermes, exact version required | Exact version required | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Not run |
| Exact release asset or commit required | macOS native | Hermes, exact version required | Exact version required | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Not run |
| Exact release asset or commit required | Linux native | Hermes, exact version required | Exact version required | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Not run |
| Exact release asset or commit required | Any host | Second ACP implementation, exact build required | Exact version required | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Not run |

For the first manual batch pass, use 2–3 small Markdown files in an isolated vault and verify all of these separately:

1. explicit selection and exact file/character/model-turn preflight;
2. one fresh no-history turn per note;
3. stop during generation and safe close/discard behavior;
4. a complete diff and separate approve/reject decision for every draft;
5. one final confirmation before the first write;
6. zero writes when any approved target is stale;
7. accurate per-file results after an injected later-write failure;
8. guarded rollback of an unchanged applied result;
9. recovery-required state when a result diverges or is open;
10. restart reconciliation, guarded recovery/undo, and deletion controls in the packaged build.

Multi-file writes are not a filesystem transaction. A successful manual matrix demonstrates the observed cases only; it does not create a transactional guarantee.

## Metadata-only report template

The tester prepares and reviews this report locally before submitting the [Metadata-only beta report](https://github.com/Bum-Boo/agent-change-gate/issues/new?template=beta-feedback.yml) issue form. The plugin does not transmit it automatically. GitHub issues are public: the reporter's account, submission time, and every submitted field are visible, searchable, and may remain in forks, notifications, archives, or caches after an edit or deletion. Use a pseudonymous account if appropriate, omit anything identifying, and do not submit if public metadata collection is unacceptable. A reporter may edit or close their issue and ask the maintainer to delete it and exclude it from project totals; deletion is maintainer-controlled, and the project cannot guarantee erasure from GitHub or third-party copies. Use coarse buckets and diagnostic codes; omit free-form logs.

```yaml
schema: agent-change-gate-beta-report-v1
tester_id: random-local-alias
test_date: YYYY-MM-DD
plugin_version: x.y.z
install_method: manual-release-or-brat
host_os: windows-or-macos-or-linux
obsidian_version: x.y.z
agent_name: hermes-or-other-name
agent_version: exact-version
transport: wsl-stdio-or-native-stdio
setup_minutes_bucket: under-5-or-5-to-10-or-11-to-20-or-over-20
live_help_required: true-or-false
single_note:
  initialize: pass-fail-blocked-not-run
  ask: pass-fail-blocked-not-run
  propose_complete_diff_apply: pass-fail-blocked-not-run
  stale_block: pass-fail-blocked-not-run
  cancel: pass-fail-blocked-not-run
  guarded_undo: pass-fail-blocked-not-run
batch:
  enabled: true-or-false
  selected_file_count_bucket: not-run-or-2-to-5-or-6-to-10-or-11-to-20
  separate_turns_and_reviews: pass-fail-blocked-not-run
  final_confirmation: pass-fail-blocked-not-run
  stale_all_block: pass-fail-blocked-not-run
  partial_failure_reporting: pass-fail-blocked-not-run
  guarded_recovery: pass-fail-blocked-not-run
diagnostic_codes: []
returned_in_later_week: true-or-false
primary_value: review-gate-or-generic-chat-or-other
supporter_price_response: no-or-3-usd-or-8-usd-or-20-usd
```

Before submission, search the report for `@`, `://`, drive-letter paths, `/home/`, `/Users/`, `token`, `key`, and `secret`. Remove any matching personal or credential-bearing value. Report ordinary product failures publicly only with this metadata; report security issues privately.

## Decision rules after week four

- If fewer than 15 of 20 installers activate, fix setup and onboarding before adding features.
- If fewer than 8 return in week two or fewer than 5 return in week four, do not enable funding based on the beta.
- If fewer than 3 retained testers identify the review gate as the primary value, reconsider the positioning rather than presenting generic chat as differentiation.
- If batch remains blocked by its manual safety gate, keep it experimental and out of the external beta and monetization claim.
- If the funnel and safety gates pass, the maintainer may separately review the funding and Community Plugins gates in [COMMERCIALIZATION.md](COMMERCIALIZATION.md). Passing the beta does not automatically enable either one.
