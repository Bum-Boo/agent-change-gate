# Open-source foundations and provenance

Agent Change Gate intentionally uses upstream packages for protocol, schema, build, and test infrastructure instead of copying their implementations into this repository. `package-lock.json` is the reproducible version record; `npm ci` installs that exact dependency graph.

## Bundled runtime dependencies

| Package | Version | Role | License | Upstream source |
| --- | --- | --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.7.0 | ACP client, message types, and session protocol | Apache-2.0 | [agentclientprotocol/typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk) |
| `zod` | 4.4.3 | Runtime schema validation used by the ACP SDK | MIT | [colinhacks/zod](https://github.com/colinhacks/zod) |

Both packages are bundled and minified into `main.js`. The production banner embeds their complete license texts. Readable copies are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and [LICENSES](../LICENSES/).

## Development-only dependencies

| Package | Locked version | Role | License | Upstream source |
| --- | --- | --- | --- | --- |
| `obsidian` | 1.14.4 | Obsidian public API types and declarations | MIT | [obsidianmd/obsidian-api](https://github.com/obsidianmd/obsidian-api) |
| `esbuild` | 0.28.2 | Production bundle generation | MIT | [evanw/esbuild](https://github.com/evanw/esbuild) |
| `typescript` | 5.9.3 | Static type checking | Apache-2.0 | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) |
| `vitest` | 5.0.3 | Unit and regression test runner | MIT | [vitest-dev/vitest](https://github.com/vitest-dev/vitest) |
| `@types/node` | 24.19.1 | Node.js development type declarations | MIT | [DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |

These tools support development and are not shipped as separate runtime packages. `esbuild` produces the single-file plugin bundle; the other entries provide types or tests.

## External integration

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is a supported, user-installed ACP agent and the first-class setup path. It is not a dependency, is not bundled into Agent Change Gate, and is not maintained by this project.

## Project-authored code

The scope-capture rules, stale-snapshot checks, bounded complete line diff, Unicode review hardening, retention and recovery limits, scope receipts, subprocess restrictions, and Obsidian user interface in this repository are project-authored. They were not copied from the dependencies listed above.

## Adding or adapting external code

Every future dependency or adapted implementation must record:

- its upstream source URL;
- the exact package version or source commit;
- its license and required notices;
- whether it is bundled into distributed files;
- a clear note describing local modifications, if any.

Update this document, `THIRD_PARTY_NOTICES.md`, required license copies, and the production bundle banner together when runtime provenance changes.
