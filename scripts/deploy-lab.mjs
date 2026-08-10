import { access, copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const vaultInput = process.env.OBSIDIAN_LAB_VAULT?.trim();
if (!vaultInput || !path.isAbsolute(vaultInput)) {
  throw new Error("Set OBSIDIAN_LAB_VAULT to an absolute path for an isolated test vault.");
}
const vault = await realpath(vaultInput);

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function assertOrdinaryContainedPath(candidate, root, label) {
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) {
    throw new Error(`Refusing deployment: ${label} is a symlink, junction, or hard-linked file.`);
  }
  const resolved = await realpath(candidate);
  if (!isContained(root, resolved)) {
    throw new Error(`Refusing deployment: ${label} resolves outside the isolated lab vault.`);
  }
}

async function ensureContainedDirectory(candidate, root, label) {
  try {
    await mkdir(candidate);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Refusing deployment: ${label} is not an ordinary directory.`);
  }
  const resolved = await realpath(candidate);
  if (!isContained(root, resolved)) {
    throw new Error(`Refusing deployment: ${label} resolves outside the isolated lab vault.`);
  }
  return resolved;
}

const markerPath = path.join(vault, ".agent-change-gate-lab");
let marker = "";
try {
  await assertOrdinaryContainedPath(markerPath, vault, "lab marker");
  marker = await readFile(markerPath, "utf8");
} catch {
  throw new Error(`Refusing deployment: create ${markerPath} only inside the intended isolated test vault.`);
}
if (marker.trim() !== "agent-change-gate isolated test vault") {
  throw new Error(`Refusing deployment: ${markerPath} has unexpected content.`);
}

const pluginId = "agent-change-gate";
const obsidianDirectory = path.join(vault, ".obsidian");
await ensureContainedDirectory(obsidianDirectory, vault, ".obsidian directory");
const pluginsDirectory = path.join(obsidianDirectory, "plugins");
await ensureContainedDirectory(pluginsDirectory, vault, "plugins directory");
const target = path.join(pluginsDirectory, pluginId);
const targetReal = await ensureContainedDirectory(target, vault, "plugin destination");
for (const filename of ["main.js", "manifest.json", "styles.css"]) {
  const destination = path.join(target, filename);
  await assertOrdinaryContainedPath(destination, targetReal, `${filename} destination`);
  await copyFile(filename, destination);
}
if (process.env.AGENT_CHANGE_GATE_MIGRATE_LEGACY_DATA === "1") {
  const legacyData = path.join(vault, ".obsidian", "plugins", "bounded-note-chat", "data.json");
  const targetData = path.join(target, "data.json");
  await assertOrdinaryContainedPath(targetData, targetReal, "data.json destination");
  try {
    await access(targetData);
    console.log("Kept existing Agent Change Gate data.json; legacy data was not overwritten.");
  } catch {
    try {
      await assertOrdinaryContainedPath(legacyData, vault, "legacy data.json source");
      await copyFile(legacyData, targetData);
      console.log("Copied local alpha settings from bounded-note-chat without deleting the legacy file.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      console.log("No legacy bounded-note-chat data.json was available to migrate.");
    }
  }
}
console.log(`Deployed ${pluginId} to ${target}`);
