# ACP compatibility

Agent Change Gate uses the official `@agentclientprotocol/sdk` and speaks ACP over stdio. A configurable launch command does not imply that every ACP implementation is compatible.

## Compatibility matrix

| Agent | Agent version | Host OS | Obsidian | Transport | Checked | Status | Model turn |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hermes Agent | 0.20.0 | Windows | 1.13.4 | WSL stdio: `hermes -p <profile> acp` | 2026-08-10 | Initialize-only | Not run |

The automated suite also verifies argv-only spawning, denied client filesystem/terminal methods, fail-closed permission handling, bounded responses, session lifecycle, state retention, and cancellation behavior. It is not a substitute for an end-to-end test against each agent build or a manual Obsidian GUI test.

## Support labels

- **Verified:** initialize plus ask/edit/cancel workflows tested against the exact listed version.
- **Initialize-only:** the ACP handshake passed; full model behavior is not yet claimed.
- **Community-reported:** a user supplied reproducible results that the maintainer has not independently repeated.
- **Unknown:** configurable, but not tested.

Until another implementation reaches **Verified**, public copy should say “Hermes first-class; other compatible ACP agents configurable,” not “works with every ACP agent.”

## Reporting a result

Open a compatibility-report issue without prompts, credentials, or vault content. Include the operating system, Obsidian version, transport, exact agent version, launch argument shape with secrets removed, and which of initialize, ask, propose, apply, stale-block, and cancel succeeded.
