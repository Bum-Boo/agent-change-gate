import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const excludedDirectories = new Set([".git", "dist", "node_modules"]);
const requiredPackagedFiles = [
  "README.md",
  "PRIVACY.md",
  "SECURITY.md",
  "docs/BETA_TESTING.md",
  "docs/COMMERCIALIZATION.md",
  "docs/COMPATIBILITY.md",
  "docs/OPEN_SOURCE.md",
  "docs/README.ko.md",
  "docs/assets/complete-diff-review.jpg",
  "docs/assets/hermes-scope-only-reply.jpg",
  "docs/assets/reviewed-edit-applied.jpg",
];

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        files.push(...await markdownFiles(path.join(directory, entry.name)));
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function localTargets(markdown) {
  const withoutFencedCode = markdown.replace(/```[\s\S]*?```/gu, "");
  const targets = [];
  for (const match of withoutFencedCode.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    const raw = match[1]?.trim();
    if (raw) targets.push(raw);
  }
  for (const match of withoutFencedCode.matchAll(/^\s*\[[^\]]+\]:\s+(\S+)/gmu)) {
    const raw = match[1]?.trim();
    if (raw) targets.push(raw);
  }
  return targets;
}

function normalizeTarget(raw) {
  let target = raw;
  if (target.startsWith("<")) {
    const closing = target.indexOf(">");
    target = closing >= 0 ? target.slice(1, closing) : target.slice(1);
  } else {
    target = target.split(/\s+/u)[0] ?? "";
  }
  if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(target)) return null;
  target = target.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  if (!target) return null;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

const failures = [];
const files = await markdownFiles(root);
let checked = 0;
const checkedImages = new Set();
for (const file of files) {
  const markdown = await readFile(file, "utf8");
  for (const raw of localTargets(markdown)) {
    const target = normalizeTarget(raw);
    if (!target) continue;
    checked += 1;
    const resolved = path.resolve(path.dirname(file), target.replaceAll("/", path.sep));
    const relative = path.relative(root, resolved);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      failures.push(`${path.relative(root, file)} -> ${raw} escapes the repository`);
      continue;
    }
    try {
      await stat(resolved);
      const extension = path.extname(resolved).toLowerCase();
      if (!checkedImages.has(resolved) && [".jpg", ".jpeg", ".png"].includes(extension)) {
        checkedImages.add(resolved);
        const bytes = await readFile(resolved);
        const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        const isPng = bytes.length >= 8
          && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        if ((extension === ".png" && !isPng) || ([".jpg", ".jpeg"].includes(extension) && !isJpeg)) {
          failures.push(`${path.relative(root, resolved)} has content that does not match its image extension`);
        }
      }
    } catch {
      failures.push(`${path.relative(root, file)} -> ${raw} does not exist`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Broken local documentation links:\n${failures.join("\n")}`);
}
const packageScript = await readFile(path.join(root, "scripts", "package-release.mjs"), "utf8");
for (const required of requiredPackagedFiles) {
  if (!packageScript.includes(`\"${required}\"`)) {
    failures.push(`scripts/package-release.mjs does not stage ${required}`);
  }
}
if (failures.length > 0) {
  throw new Error(`Broken local documentation links or package closure:\n${failures.join("\n")}`);
}
console.log(`Validated ${checked} local links and ${checkedImages.size} image assets across ${files.length} Markdown files.`);
