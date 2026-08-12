import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const releaseNotes = `docs/releases/${manifest.version}.md`;

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
for (const [source, destination] of [
  ["main.js", "main.js"],
  ["manifest.json", "manifest.json"],
  ["styles.css", "styles.css"],
  ["LICENSE", "LICENSE"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["LICENSES/Apache-2.0.txt", "LICENSES/Apache-2.0.txt"],
  ["LICENSES/Zod-MIT.txt", "LICENSES/Zod-MIT.txt"],
  ["docs/OPEN_SOURCE.md", "docs/OPEN_SOURCE.md"],
  ["docs/BETA_TESTING.md", "docs/BETA_TESTING.md"],
  ["docs/COMPATIBILITY.md", "docs/COMPATIBILITY.md"],
  ["docs/COMMERCIALIZATION.md", "docs/COMMERCIALIZATION.md"],
  ["docs/README.ko.md", "docs/README.ko.md"],
  [releaseNotes, releaseNotes],
  ["docs/assets/hermes-scope-only-reply.jpg", "docs/assets/hermes-scope-only-reply.jpg"],
  ["docs/assets/complete-diff-review.jpg", "docs/assets/complete-diff-review.jpg"],
  ["docs/assets/reviewed-edit-applied.jpg", "docs/assets/reviewed-edit-applied.jpg"],
  ["README.md", "README.md"],
  ["PRIVACY.md", "PRIVACY.md"],
  ["SECURITY.md", "SECURITY.md"],
]) {
  const stagedPath = `dist/${destination}`;
  await mkdir(dirname(stagedPath), { recursive: true });
  await copyFile(source, stagedPath);
}
console.log("Staged Obsidian release assets and license notices in dist/.");
