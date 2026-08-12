import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const version = manifest.version;
const releaseNotesPath = `docs/releases/${version}.md`;
const truthFiles = [
  "README.md",
  "CHANGELOG.md",
  "PRIVACY.md",
  "SECURITY.md",
  "docs/BETA_TESTING.md",
  "docs/COMMERCIALIZATION.md",
  "docs/COMPATIBILITY.md",
  "docs/README.ko.md",
  releaseNotesPath,
];
const contents = new Map(await Promise.all(truthFiles.map(async (file) => (
  [file, await readFile(file, "utf8")]
))));
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const versionToken = `(?:${escapedVersion}|${String.raw`\x60`}${escapedVersion}${String.raw`\x60`})`;
const staleMarkers = [
  new RegExp(`${versionToken}.{0,120}(?:unreleased|has not been published|still unreleased)`, "isu"),
  new RegExp(`unreleased.{0,80}${versionToken}`, "isu"),
  new RegExp(`${versionToken}.{0,80}(?:릴리스되지 않은|미출시)`, "su"),
  /verification still required/iu,
];
const failures = [];

for (const [file, fileContents] of contents) {
  if (staleMarkers.some((pattern) => pattern.test(fileContents))) {
    failures.push(`${file} still describes ${version} as unreleased or unverified.`);
  }
}
const readme = contents.get("README.md") ?? "";
if (!readme.includes(`Version \`${version}\` is the latest published GitHub prerelease.`)) {
  failures.push(`README.md does not identify ${version} as the latest published GitHub prerelease.`);
}
const changelog = contents.get("CHANGELOG.md") ?? "";
if (!new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`, "mu").test(changelog)) {
  failures.push(`CHANGELOG.md has no dated ${version} release heading.`);
}

if (failures.length > 0) {
  throw new Error(`Public release truth gate failed:\n${failures.join("\n")}`);
}
console.log(`Public release truth is synchronized for ${version}.`);
