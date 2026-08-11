# ACP compatibility

Agent Change Gate uses the official `@agentclientprotocol/sdk` and speaks ACP over stdio. A configurable launch command does not imply that every ACP implementation is compatible.

## Compatibility matrix

| Agent | Agent version | Host OS | Obsidian | Transport | Checked | Status | Model turn |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hermes Agent | 0.20.0 | Windows | 1.13.4 | WSL stdio: `hermes -p <profile> acp` | 2026-08-11 | Initialize-only | Not run |

The automated suite also verifies argv-only spawning, denied client filesystem/terminal methods, fail-closed permission handling, bounded responses, session lifecycle, state retention, and cancellation behavior. It is not a substitute for an end-to-end test against each agent build or a manual Obsidian GUI test.

The unreleased `0.3.0` development suite additionally exercises bounded Markdown batch candidate selection, protected path exclusions, proposal-to-snapshot identity, and all-target stale preflight helpers. This is helper-level evidence only. No batch GUI flow, real-model multi-note run, partial-write recovery, or rollback has been verified against Hermes or another ACP implementation.

## Support labels

- **Verified:** initialize plus ask/edit/cancel workflows tested against the exact listed version.
- **Initialize-only:** the ACP handshake passed; full model behavior is not yet claimed.
- **Community-reported:** a user supplied reproducible results that the maintainer has not independently repeated.
- **Unknown:** configurable, but not tested.

For batch support, **Verified** additionally requires selecting notes, generating separate no-history turns, reviewing every draft, final confirmation, applying an all-current set, blocking a stale set before the first write, cancellation, partial-failure reporting, and guarded recovery against the exact listed agent and Obsidian versions.

Until another implementation reaches **Verified**, public copy should say “Hermes first-class; other compatible ACP agents configurable,” not “works with every ACP agent.” Until the `0.3.0` batch matrix reaches **Verified**, public copy must also label Vault Batch Review experimental and unverified rather than implying production-ready vault automation.

## Reporting a result

Open a compatibility-report issue without prompts, credentials, or vault content. Include the operating system, Obsidian version, transport, exact agent version, launch argument shape with secrets removed, and which of initialize, ask, propose, apply, stale-block, and cancel succeeded. For an experimental batch report, also state the selected file count and whether separate turn generation, per-draft review, final confirmation, stale-all block, partial-failure reporting, and guarded recovery succeeded; never attach real note text or model output.
