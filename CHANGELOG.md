# Changelog

## 0.2.0 - 2026-08-11

- Repositioned the plugin as Agent Change Gate: a review-before-write ACP client with first-class Hermes setup.
- Added custom ACP launch profiles without shell interpolation or stored secret environment values.
- Added request cancellation, bounded complete line diffs (exact for normal comparisons with a coarse complete fallback), and scope receipts that omit instruction, note-body, and model-response plaintext.
- Added clearer onboarding, inert plain-text agent replies, and capability-boundary messaging.
- Added fresh per-turn sessions, bounded transport framing, serialized state writes, bounded local retention, and visible Unicode review markers.

## 0.1.0 - 2026-08-10 (internal prototype, not published)

- Added native and Windows/WSL Hermes ACP discovery.
- Added per-agent, per-note persistent chat threads.
- Added body, selection, and YAML frontmatter scopes.
- Added strict proposal parsing, diff approval, stale response protection, and local undo snapshots.
- Added privacy controls, fail-closed ACP permissions, configurable context limits, tests, CI, and release staging.
