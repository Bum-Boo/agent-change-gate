# Security policy

## Supported versions

Only the latest published prerelease receives security fixes.

| Version | Supported |
| --- | --- |
| `0.2.0` | Yes |
| `< 0.2.0` | No |

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Bum-Boo/agent-change-gate/security/advisories/new). Do not report vulnerabilities through public GitHub Issues. Never include real vault contents, credentials, provider keys, profile `.env` files, or private prompts in a public report.

## Trust boundaries

Agent Change Gate controls what its Obsidian host sends and what edits its host applies. It does not sandbox Hermes, another ACP process, or the configured model provider.

Host-side protections include:

- exact note-path and content snapshot validation;
- explicit scope selection;
- schema-validated response parsing and size limits;
- inert plain-text rendering for agent replies, without Markdown postprocessors or embeds;
- empty and malformed replacement blocking;
- bounded complete diff review before every plugin-applied edit, with bidi controls blocked and invisible review characters labeled;
- bounded persistent history and expiring recovery snapshots;
- no shell interpolation;
- restricted subprocess environment;
- no ACP filesystem/terminal capabilities;
- fail-closed permission handling;
- the Hermes MCP-suppression flag plus an empty ACP session MCP list for first-class Hermes launches;
- fresh ACP sessions with advertised close requests or an idle child restart fallback;
- default/session working directories configured outside the vault, with obvious custom vault descendants rejected lexically.

Residual risks include:

- the ACP agent is a local executable with its own tools and operating-system permissions;
- a configured model provider may retain or process note content remotely;
- note text and optional prior replies are labeled as untrusted data, but a model or agent can still follow prompt injection inside them and use agent-owned tools or network access;
- malicious or compromised agent binaries are outside the plugin's control;
- Obsidian community plugins generally run with broad desktop privileges;
- recovery snapshots temporarily duplicate note content in plugin state;
- the working-directory check is not a filesystem sandbox and does not resolve every symlink or process-controlled path behavior;
- a child can ignore cancellation, MCP-suppression, working-directory, or tool-use instructions, although the host will not apply a cancelled turn's proposal.

The gate covers context selected in Agent Change Gate and note writes performed by Agent Change Gate. It does not prove that the separate ACP process cannot access other local resources. For high-sensitivity vaults, use an OS account, VM, or container dedicated to the workflow and a provider policy appropriate for the data.
