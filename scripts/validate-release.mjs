import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
const mainBundle = await readFile("main.js", "utf8");
const thirdPartyNotices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
const openSourceProvenance = await readFile("docs/OPEN_SOURCE.md", "utf8");
const apacheLicense = await readFile("LICENSES/Apache-2.0.txt", "utf8");
const zodLicense = await readFile("LICENSES/Zod-MIT.txt", "utf8");
const lockedPackages = JSON.parse(await readFile("package-lock.json", "utf8")).packages;

const lockedVersion = (name) => {
  const version = lockedPackages[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`package-lock.json does not lock ${name}.`);
  return version;
};

if (manifest.id !== "agent-change-gate") throw new Error("Unexpected plugin ID.");
if (manifest.name !== "Agent Change Gate") throw new Error("Unexpected plugin name.");
if (manifest.author !== "Bum-Boo" || packageJson.author !== "Bum-Boo") {
  throw new Error("Release author metadata is incomplete.");
}
if (manifest.version !== packageJson.version) throw new Error("manifest.json and package.json versions differ.");
if (packageJson.repository?.url !== "git+https://github.com/Bum-Boo/agent-change-gate.git") {
  throw new Error("package.json does not point to the canonical repository.");
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error("versions.json does not map the current version to minAppVersion.");
}
if (manifest.isDesktopOnly !== true) throw new Error("This subprocess-based plugin must be desktop-only.");
if (!mainBundle.includes(`Agent Change Gate ${manifest.version}`)) {
  throw new Error("main.js is missing the current-version license banner.");
}
if (!mainBundle.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION")
  || !mainBundle.includes("Copyright (c) 2025 Colin McDonnell")) {
  throw new Error("main.js does not embed the bundled dependency license texts.");
}
if (!thirdPartyNotices.includes("Agent Client Protocol TypeScript SDK") || !thirdPartyNotices.includes("Zod")) {
  throw new Error("THIRD_PARTY_NOTICES.md is incomplete.");
}
for (const sourceUrl of [
  "https://github.com/agentclientprotocol/typescript-sdk",
  "https://github.com/colinhacks/zod",
  "https://github.com/obsidianmd/obsidian-api",
  "https://github.com/evanw/esbuild",
  "https://github.com/microsoft/TypeScript",
  "https://github.com/vitest-dev/vitest",
  "https://github.com/DefinitelyTyped/DefinitelyTyped",
  "https://github.com/NousResearch/hermes-agent",
]) {
  if (!openSourceProvenance.includes(sourceUrl)) {
    throw new Error(`Open-source provenance is missing ${sourceUrl}.`);
  }
}
for (const name of [
  "@agentclientprotocol/sdk",
  "zod",
  "obsidian",
  "esbuild",
  "typescript",
  "vitest",
  "@types/node",
]) {
  if (!openSourceProvenance.includes(`| \`${name}\` | ${lockedVersion(name)} |`)) {
    throw new Error(`docs/OPEN_SOURCE.md does not record the locked ${name} ${lockedVersion(name)}.`);
  }
}
for (const [label, name] of [
  ["Agent Client Protocol TypeScript SDK", "@agentclientprotocol/sdk"],
  ["Zod", "zod"],
]) {
  if (!thirdPartyNotices.includes(`${label}](`) || !thirdPartyNotices.includes(`) ${lockedVersion(name)} - `)) {
    throw new Error(`THIRD_PARTY_NOTICES.md does not record the bundled ${name} ${lockedVersion(name)}.`);
  }
}
if (!apacheLicense.includes("Apache License") || !apacheLicense.includes("Version 2.0")) {
  throw new Error("The bundled ACP SDK license copy is missing.");
}
if (!zodLicense.includes("MIT License") || !zodLicense.includes("Colin McDonnell")) {
  throw new Error("The bundled Zod license copy is missing.");
}
console.log(`Release metadata valid for ${manifest.id} ${manifest.version}.`);
