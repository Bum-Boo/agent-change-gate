# Changelog

## 0.3.0 - Unreleased

- Added an experimental, opt-in Vault Batch Review flow for an explicitly selected, bounded set of Markdown notes.
- Isolated batch work into one fresh ACP turn per note without conversation history; every returned draft remains subject to its own bounded diff review and a final batch confirmation.
- Limited a batch to at most 20 files and 500,000 selected-scope characters, with exact path/content rechecks before any write begins.
- Added guarded batch recovery and best-effort rollback for matching files while documenting that multi-file writes are not atomic and can complete only partially.
- Kept unattended writes, file creation, deletion, moves, renames, and non-Markdown changes outside the feature boundary.
- Added a three-step connection readiness flow, bounded redacted diagnostic codes, payload previews, durable per-file batch results, responsive controls, and improved screen-reader status regions.
- Added host-path failure and rollback tests, Windows CI, documentation-link validation, metadata-only privacy-guided beta/bug report forms, and an external-beta evidence protocol.

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
