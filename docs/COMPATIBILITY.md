# ACP compatibility

Agent Change Gate uses the official `@agentclientprotocol/sdk` and speaks ACP over stdio. A configurable launch command does not imply that every ACP implementation is compatible.

## Compatibility matrix

| Agent | Agent version | Host OS | Obsidian | Transport | Checked | Status | Model turn |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hermes Agent | 0.20.0 | Windows | 1.13.6 | WSL stdio: `hermes -p <profile> acp` | 2026-08-13 | Single-note Lab smoke | One Ask passed; one edit proposal reached a complete diff and was explicitly applied |

The 2026-08-13 result came from an isolated disposable vault, not the maintainer's personal vault. It used an unreleased `0.3.0` development working tree, but no exact commit or packaged-asset identity was recorded at capture time. It verifies only the two listed single-note turns as limited UI evidence, not as reproducible release proof. It did not manually exercise cancellation, stale-response rejection, guarded undo, batch generation, batch apply, rollback, or recovery.

The automated suite verifies argv-only spawning, denied client filesystem/terminal methods, fail-closed permission handling, bounded responses, fresh ACP sessions, state retention, cancellation behavior, bounded batch selection, stale all-target preflight, and guarded recovery helpers. Host integration tests also cover zero writes on a stale batch target and guarded rollback after an injected write failure. These tests are not substitutes for end-to-end checks against each agent build or manual Obsidian GUI testing.

The unreleased `0.3.0` development suite additionally exercises bounded Markdown batch candidate selection, protected path exclusions, proposal-to-snapshot identity, all-target stale preflight, and guarded host rollback paths. This is automated evidence only. No batch GUI flow, real-model multi-note run, partial-write recovery, or rollback has been manually verified against Hermes or another ACP implementation.

## Support labels

- **Verified:** initialize plus ask/edit/cancel, stale rejection, and guarded single-note undo workflows tested against the exact listed version.
- **Single-note Lab smoke:** initialize and the specifically listed real-model single-note turns passed, but the complete **Verified** matrix did not.
- **Initialize-only:** the ACP handshake passed; full model behavior is not yet claimed.
- **Community-reported:** a user supplied reproducible results that the maintainer has not independently repeated.
- **Unknown:** configurable, but not tested.

For batch support, **Verified** additionally requires selecting notes, generating separate no-history turns, reviewing every draft, final confirmation, applying an all-current set, blocking a stale set before the first write, cancellation, partial-failure reporting, and guarded recovery against the exact listed agent and Obsidian versions.

Until another implementation reaches **Verified**, public copy should say “Hermes first-class; other compatible ACP agents configurable,” not “works with every ACP agent.” Until the `0.3.0` batch matrix reaches **Verified**, public copy must also label Vault Batch Review experimental and unverified rather than implying production-ready vault automation.

## Reporting a result

Open a compatibility-report issue without prompts, credentials, vault content, absolute paths, or launch commands. Include the operating system, Obsidian version, transport category, exact agent version, and which of initialize, ask, propose, apply, stale-block, and cancel succeeded. For an experimental batch report, also state only a coarse selected-file-count bucket and whether separate turn generation, per-draft review, final confirmation, stale-all block, partial-failure reporting, and guarded recovery succeeded; never attach real note text or model output. External beta testers should use the metadata-only template in [BETA_TESTING.md](BETA_TESTING.md).
