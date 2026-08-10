import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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
  ["README.md", "README.md"],
  ["PRIVACY.md", "PRIVACY.md"],
  ["SECURITY.md", "SECURITY.md"],
]) {
  const stagedPath = `dist/${destination}`;
  await mkdir(dirname(stagedPath), { recursive: true });
  await copyFile(source, stagedPath);
}
console.log("Staged Obsidian release assets and license notices in dist/.");
