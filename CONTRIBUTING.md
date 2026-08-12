# Contributing

## Local checks

Use Node 20.19.0+, 22.12.0+, or 24+ (even-numbered supported release lines only).

```bash
npm ci
npm run check
```

Do not commit vault contents, `data.json`, credentials, profile files, provider responses, or generated `main.js`.

## Safety invariants

Changes must preserve these invariants:

1. A thread key includes both versioned agent launch identity and exact note path.
2. The captured note path and exact content must still match at apply time.
3. Agent output is a proposal; a diff and explicit user action precede every plugin write.
4. The plugin does not advertise ACP filesystem or terminal capability.
5. Permission requests fail closed.
6. The host prompt never includes the absolute vault path; obvious custom workspaces inside the vault are rejected, but this is not a symlink-aware sandbox.
7. Active IME composition never submits a turn.

Add regression tests for any change to scope capture, response parsing, subprocess launch, persistence, or edit application.

## Dependency and source provenance

Prefer maintained upstream packages over copied implementations. When adding a dependency or adapting external code, record its upstream URL, exact version or commit, license and required notices, whether it is bundled, and what was modified. Update [docs/OPEN_SOURCE.md](docs/OPEN_SOURCE.md), runtime notices, license copies, and the production bundle banner whenever their contents change.
