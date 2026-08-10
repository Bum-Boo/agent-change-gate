# Privacy

Last updated: 2026-08-10

## Summary

Agent Change Gate has no analytics, advertising, telemetry, user account, or direct HTTP client. It communicates with a locally installed ACP agent over stdio. Hermes has first-class discovery; users may also configure another compatible ACP process.

## Data sent to the selected ACP agent

Each turn includes:

- the instruction typed into the plugin;
- the vault-relative logical path of the active note;
- the chosen body, selection, or YAML frontmatter text;
- the requested task and scope labels.

Conversation context is off by default. If the user selects **Context: exact-scope thread**, the turn also includes up to 12 recent visible user/assistant messages, each truncated to 4,000 characters, from the same agent, note, and captured scope identity (scope type, range, and content hash). Those messages contain earlier instructions and replies and may quote note content from that same captured scope.

ACP initialization sends the plugin client name, title, version, protocol version, and an empty client-capabilities object. Starting a turn asks the agent to create a fresh session with an absolute temporary or user-configured working directory and an empty MCP-server list; the agent returns the session ID used for that turn. An absolute working directory can reveal operating-system path components such as a username. The plugin does not intentionally configure the vault path as that directory, but its lexical guard is not a symlink-aware sandbox.

The plugin does not intentionally send the absolute vault path. It does not read profile `.env` files, provider authentication stores, cookies, or secrets.

Agent replies are rendered as inert plain text. They do not invoke Obsidian Markdown postprocessors, images, embeds, raw HTML, or automatic links.

The selected agent can send the prompt to its configured model provider. Provider retention, training, regional processing, billing, and legal terms are outside this plugin and must be reviewed by the user.

## Local storage

Obsidian stores plugin state in `.obsidian/plugins/agent-change-gate/data.json`. It may contain:

- plaintext launch settings that users are warned must not contain secrets;
- 4 to 100 configured chat messages per agent-launch-identity/note thread, with at most 24,000 characters in any hydrated message;
- full-note before/after recovery snapshots for eligible applied edits, even when the sent scope was only a selection or frontmatter;
- up to 500 scope receipts without instruction, note-body, or model-response plaintext, retained for 90 days.

`data.json` is ordinary plaintext JSON; chats and full-note recovery snapshots are not encrypted by this plugin. Depending on vault settings, Obsidian Sync, Dropbox, OneDrive, backup software, or another synchronization tool may copy plugin data off-device. “Local storage” here means plugin-owned storage, not a guarantee that the file remains on one device.

Chat storage is automatically pruned on save to at most 200 threads, 2,000,000 message characters in total, and 180 days of retention. Recovery storage is limited to 20 snapshots, 3,000,000 characters in total, 600,000 combined before/after characters and 4,000 combined logical lines per snapshot, and 30 days of retention. An oversized edit can be applied after review but receives no plugin recovery snapshot.

Scope receipts contain the agent profile ID plus a non-secret launch fingerprint, vault-relative note path, task, scope, scope character count and SHA-256 hash, optional-history character count and SHA-256 hash, timestamps, and outcome. They do not contain the instruction, note text, or model reply. SHA-256 values are deterministic fingerprints, not anonymization: someone who can guess low-entropy content can test that guess against a stored hash. Users can separately clear chat history, recovery snapshots, and scope receipts from plugin settings. Uninstalling the plugin directory removes its local state if `data.json` is removed with it.

## Agent-side storage

An ACP agent may persist sessions, prompts, provider responses, memory, or logs under its own directories. The plugin creates a fresh ACP session for each turn. It requests agent-side close when that capability is advertised; otherwise it restarts the child after active turns finish. This bounds the plugin-managed process lifecycle but does not prove that the agent deleted provider-side or durable records. The plugin does not store ACP session IDs in `data.json` and cannot delete agent-side records. Use the agent's own management tools and retention policy for that data.

## Processes and network

Hermes discovery may run `wsl.exe` checks (`printenv`, `which`), an executable version check, and `hermes profile list`. A conversation or initialize-only check starts the detected Hermes executable or an explicitly configured ACP executable, directly or through `wsl.exe`, with `shell: false`. Agent Change Gate sends no model prompt during that check, but startup behavior inside the executable is outside the gate. The plugin does not download or update agent binaries.

Children receive a restricted allowlist of operating-system environment fields needed for process launch, locale, and path resolution, plus fixed encoding/color flags and the documented Hermes-specific fields. Values such as `HOME`, `USERPROFILE`, temporary paths, and `PATH` can reveal local path or username metadata to the child. Provider credentials are expected to be managed by the agent itself and cannot be entered through a custom environment field in this plugin. Custom argv is stored locally, so users must not place secrets in arguments.

No telemetry or update check is performed by the plugin. Any network activity comes from the chosen agent and its configured provider or built-in behavior.

## Changes

Material privacy changes should be documented in the changelog and release notes before a new version is published.
