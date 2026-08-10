import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import process from "node:process";

const production = process.argv[2] === "production";
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const projectLicense = await readFile("LICENSE", "utf8");
const apacheLicense = await readFile("LICENSES/Apache-2.0.txt", "utf8");
const zodLicense = await readFile("LICENSES/Zod-MIT.txt", "utf8");
const legalBanner = [
  "/*!",
  `Agent Change Gate ${manifest.version} — bundled/minified distribution.`,
  "Agent Change Gate license:",
  projectLicense,
  "Bundled Agent Client Protocol TypeScript SDK — Apache License 2.0:",
  apacheLicense,
  "Bundled Zod — MIT License:",
  zodLicense,
  "*/",
].join("\n");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr"
  ],
  format: "cjs",
  platform: "node",
  target: "es2022",
  logLevel: "info",
  banner: production
    ? { js: legalBanner }
    : undefined,
  legalComments: "inline",
  minify: production,
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
