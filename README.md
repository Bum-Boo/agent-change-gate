# Agent Change Gate

[![CI](https://github.com/Bum-Boo/agent-change-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/Bum-Boo/agent-change-gate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> ACP-proposed edits returned through this chat are scope-checked and stay drafts until you review them.

Agent Change Gate is a desktop ACP client for deliberate note work. Choose the current note body, an exact selection, or existing YAML frontmatter when you send a request. The plugin captures that scope, keeps the conversation tied to the note and agent, and treats every proposed replacement as a draft.

The unreleased `0.3.0` development branch also adds an experimental, opt-in **Vault Batch Review** flow. It operates only on an explicitly selected, bounded set of Markdown notes. Each selected note is sent in its own fresh ACP turn without conversation history, each returned draft is reviewed separately, and approved drafts still require one final batch confirmation before any write begins.

A reviewable draft is shown as a bounded, complete line diff and is applied only after you approve it. Normal-sized comparisons use an exact line diff; when exact comparison work exceeds the bound, the modal uses a coarse but complete remove/add fallback. Oversized proposals that cannot be rendered completely are not applyable. If the note path or captured content changed while the agent was responding, the proposal is refused instead of being applied to stale text.

> Status: `0.3.0` is under development and has not been released. The latest downloadable version remains the public `0.2.0` prerelease, which is not listed in Obsidian Community Plugins. Core helpers have automated tests and Hermes ACP initialization has been verified, but the `0.3.0` batch GUI, real-model batch turns, recovery flow, external beta use, and broader compatibility remain unverified.

## What the gate covers

The gate covers context selected in Agent Change Gate and note writes performed by Agent Change Gate:

- by default, the only current-note text in the host prompt is the chosen body, selection, or frontmatter scope;
- an opt-in context control can additionally send up to 12 visible user/assistant messages associated with the same exact scope identity (kind, range, and content);
- conversations are separated by agent launch identity and vault-relative note path, so changing an executable or workspace does not silently forward old context;
- ACP client filesystem and terminal capabilities are not granted, and permission requests fail closed;
- every plugin-applied note change requires an explicit diff approval;
- stale note-path or content snapshots are refused;
- a local checkpoint supports one guarded undo when its bounded review diff can be rendered;
- scope receipts omit instruction, note-body, and model-response plaintext while recording size, deterministic hashes, and outcome;
- experimental batch mode is off by default, accepts at most 20 explicitly selected Markdown notes and 500,000 selected-scope characters, sends one fresh no-history ACP turn per note, and requires separate draft reviews plus a final batch confirmation;

## What it does not cover

Agent Change Gate does **not** sandbox the ACP process. Hermes and other agents run as separate local processes and may have their own tools, network access, model providers, credentials, memory, and operating-system permissions. The gate does not prove that an agent cannot access data outside the selected scope, that content stays on-device, or that other plugins cannot change a vault.

Use agents you trust. Use an isolated OS account, VM, or container when you need a real process-security boundary.

## Built for

- focused conversations that return to the same note and agent;
- review-before-write editing of note bodies, selections, and frontmatter;
- bounded, user-selected batch work where every Markdown note is sent separately, reviewed separately, and applied only after a final batch confirmation;
- writers who prefer deliberate, guarded edits over unattended vault-wide changes;
- existing Hermes users who want first-class discovery without locking the product to one ACP runtime.

## Not built for

- unattended, unreviewed, or open-ended vault automation;
- file creation, deletion, moves, renames, or non-Markdown writes;
- granting an agent direct filesystem or terminal control through this plugin;
- installing or configuring models, provider accounts, or agent software;
- mobile use;
- serving as an operating-system sandbox.

## Requirements

- Obsidian desktop 1.13.4 or newer;
- either Hermes Agent with a configured profile, or a compatible ACP stdio agent you configure explicitly;
- any model/provider credentials managed by that agent, never pasted into this plugin.

Windows native and WSL transports are supported. Hermes auto-detection tries WSL first on Windows, then a native executable.

## Install the latest published prerelease

1. Download `agent-change-gate-0.2.0.zip` from the [0.2.0 GitHub prerelease](https://github.com/Bum-Boo/agent-change-gate/releases/tag/0.2.0).
2. Extract the full archive, including its license notices, into:

   ```text
   <vault>/.obsidian/plugins/agent-change-gate/
   ```

   Obsidian loads `main.js`, `manifest.json`, and `styles.css`; keep `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `LICENSES/` beside them.

3. In Obsidian, open **Settings → Community plugins**, reload plugins, and enable **Agent Change Gate**.
4. Open **Settings → Agent Change Gate** and run **Detect and check agents**.

## Hermes quick start

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is the first-class setup path. Its launch contract is:

```text
hermes -p <profile-id> acp
```

For WSL installations that do not place `hermes` on `PATH`, set its absolute Linux executable path. The plugin never installs, upgrades, or rewrites Hermes profiles.

Hermes is user-installed external software. It is not bundled with or maintained by Agent Change Gate.

## Other ACP agents

Settings can register an argv-only launch profile with:

- a stable local label;
- native or WSL transport;
- an executable command;
- one literal argument per line;
- an explicit ACP working directory.

Commands are spawned directly with `shell: false`. There is intentionally no custom environment-variable field. Arguments are persisted in Obsidian plugin data, so never place tokens, API keys, or passwords in them; configure credentials through the agent's own secure mechanism.

Configurable does not mean universally compatible. See the exact tested versions in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Use

### Single-note chat

1. Open a Markdown note.
2. Open Agent Change Gate from the shielded chat icon.
3. Choose an agent, **Ask** or **Suggest an edit**, and a scope.
4. Send the request. Enter sends; Shift+Enter inserts a newline; active IME composition does not submit.
5. Use **Stop** to stop waiting locally and request ACP cancellation. The child may ignore that request, but no proposal from that turn is applied.
6. For an edit, inspect added and removed lines, then choose **Apply this edit** or **Discard**.
7. Open **Scope receipts** to inspect the local outcome log, which omits instruction, note-body, and model-response plaintext.

### Experimental Vault Batch Review (`0.3.0` development)

Batch mode is opt-in and is not present in the published `0.2.0` archive. In the `0.3.0` development build:

1. Enable **Vault Batch Review (experimental)** in plugin settings.
2. Open the batch review command and explicitly select up to 20 Markdown notes. Protected plugin/configuration folders and non-Markdown files are outside the candidate set.
3. Close every selected note that is open in an Obsidian Markdown view; open targets are excluded to prevent an editor-buffer race.
4. Choose note body or existing YAML frontmatter scope, enter one instruction, and inspect the exact file count, selected-scope character count, and model-turn count.
5. Confirm draft generation. The plugin starts one fresh ACP turn per note, in sequence, with no thread history. No note changes during generation.
6. Review every returned draft as its own bounded diff and approve or reject it. There is no unattended or one-click approve-all path.
7. Confirm the final set of approved edits. Before writing the first file, the plugin rechecks every approved path and exact captured content; any stale target blocks the batch before writing begins.
8. Inspect the per-file result. Multi-file writes are not a filesystem transaction, so a later write can fail after earlier writes succeeded. Guarded recovery and best-effort rollback restore only files that still exactly match the plugin-recorded post-edit content.

The hard batch bounds are 20 files and 500,000 selected-scope characters. Batch mode does not create, delete, move, rename, or write non-Markdown files.

## Scope rules

- **Note body** excludes existing YAML frontmatter.
- **Current selection** requires a non-empty selection captured at send time.
- **YAML frontmatter** requires an existing, complete block and only accepts a complete replacement block with parseable YAML.

An accepted edit is still refused if the active note path or exact note content no longer matches the captured snapshot.

## Privacy and local data

The plugin itself makes no HTTP requests and has no telemetry. Each single-note ACP turn contains your instruction, the vault-relative logical note path, selected scope text, and task/scope labels. Only when you opt into exact-scope thread context for single-note chat does it also include up to 12 recent visible user/assistant messages capped at 4,000 characters each. Batch mode instead starts one fresh turn per selected note and sends no thread history. The agent may send that content to its configured model provider, so a batch can create multiple billed model turns.

Local plugin data is unencrypted plaintext and can contain bounded chat history, eligible full-note before/after single-edit checkpoints, a bounded batch recovery journal with original replaced-scope text and before/after hashes, plaintext launch settings that must not contain secrets, and up to 500 scope receipts retained for 90 days. Vault sync or backup tools may copy that file off-device. At most 200 threads and 2,000,000 message characters are retained globally; checkpoint and batch recovery size, count, age, and total storage are also bounded. Receipts contain no instruction, note text, replacement, or model response, but their deterministic hashes can confirm guessed content. Chats, recovery state, and receipts have separate clear controls. Read [PRIVACY.md](PRIVACY.md) before using sensitive notes.

## Security model

Host-side controls include a schema-validated response object with size bounds, bounded diff work, inert plain-text reply rendering, exact stale-snapshot checks, review-before-write diffs, no shell interpolation, a restricted child environment, empty ACP client capabilities, denied client filesystem/terminal methods, and fail-closed permission handling. Batch mode adds deterministic candidate bounds, one no-history turn per note, an all-target stale preflight before the first write, and guarded per-file recovery. Multi-file writes remain non-atomic and best-effort rollback is not a transaction guarantee. First-class Hermes launches set Hermes' MCP-suppression flag and send an empty session MCP list; a separate process can ignore host requests.

These controls reduce accidental host-mediated access; they are not an OS sandbox for the child process. See [SECURITY.md](SECURITY.md).

Report ordinary bugs through [GitHub Issues](https://github.com/Bum-Boo/agent-change-gate/issues). Do not put sensitive vault content or vulnerability details in a public issue; follow [SECURITY.md](SECURITY.md) instead.

## Development

```bash
npm ci
npm run check
```

Deploy only to an isolated test vault:

```powershell
$env:OBSIDIAN_LAB_VAULT='C:\absolute\path\to\lab-vault'
npm run deploy:lab
```

The deploy script refuses to copy unless the vault root contains a marker file named `.agent-change-gate-lab` whose exact text is `agent-change-gate isolated test vault`. Create that marker deliberately in the test vault; never add it to a personal or production vault.

## Open-source foundations

The ACP client, runtime validation, Obsidian API types, build system, compiler, and test runner are established open-source projects. Exact versions, roles, upstream URLs, licenses, and bundling status are documented in [docs/OPEN_SOURCE.md](docs/OPEN_SOURCE.md). Runtime notices and complete bundled license texts are also kept in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES](LICENSES/).

Agent Change Gate is an independent community project. Mention of Obsidian, ACP, Hermes, or any upstream project does not imply endorsement.

## Releases and funding

Version `0.2.0` is the latest published GitHub prerelease. Version `0.3.0`, including experimental Vault Batch Review, is still unreleased development work and has no release asset or compatibility claim. GitHub prerelease availability is separate from Obsidian Community Plugins distribution.

Funding is not enabled. No donation URL or `.github/FUNDING.yml` is shipped. Sponsorship should be enabled only after external beta retention is demonstrated; see [docs/COMMERCIALIZATION.md](docs/COMMERCIALIZATION.md).

## License

[MIT](LICENSE). See [docs/OPEN_SOURCE.md](docs/OPEN_SOURCE.md) for the complete dependency provenance record.
