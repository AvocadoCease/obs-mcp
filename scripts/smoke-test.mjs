#!/usr/bin/env node
// End-to-end check against a running OBS: starts the built server over stdio, previews a test
// overlay, edits it on disk to confirm live reload, and saves the screenshots to a temp folder.
// Usage: npm run build && node scripts/smoke-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mcp-smoke-"));

const overlay = (label, colour) => `<!doctype html><html><body>
<div style="position:absolute;left:80px;bottom:90px;padding:24px 40px;background:${colour};color:#fff;
font:700 56px system-ui;border-radius:12px">${label}</div></body></html>`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "build/index.js")],
  env: { ...process.env, OBS_MCP_TOOLSETS: "design,scenes", OBS_MCP_DESIGN_DIR: outDir },
  stderr: "inherit",
});
const client = new Client({ name: "obs-mcp-smoke-test", version: "1.0.0" });
await client.connect(transport);

let failed = false;
let shot = 0;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  for (const item of result.content) {
    if (item.type === "text") console.log(`[${name}] ${item.text}`);
    if (item.type === "image") {
      const file = path.join(outDir, `${++shot}-${name}.png`);
      fs.writeFileSync(file, Buffer.from(item.data, "base64"));
      console.log(`[${name}] image saved: ${file}`);
    }
  }
  if (result.isError) failed = true;
  return result;
}

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

// Remember what OBS looked like so the test leaves it as it found it
const sceneList = await client.callTool({ name: "obs-get-scene-list", arguments: {} });
if (sceneList.isError) {
  console.log(sceneList.content[0].text);
  process.exit(1);
}
const { currentProgramSceneName, scenes } = JSON.parse(sceneList.content[0].text);
const hadPreviewScene = scenes.some((s) => s.sceneName === "Design Preview");

await call("obs-design-preview", { name: "smoke-test", html: overlay("Smoke test: v1", "#0b6cff"), waitMs: 1000 });

// Edit the file the way a designer would and give the watcher time to reload it
const entry = path.join(outDir, "smoke-test", "index.html");
fs.writeFileSync(entry, overlay("Smoke test: v2 (live reload)", "#e5484d"));
await new Promise((r) => setTimeout(r, 2000));
await call("obs-design-screenshot", { sceneName: "Design Preview" });

await call("obs-design-list", {});
if (!process.argv.includes("--keep")) {
  await call("obs-design-remove", { name: "smoke-test" });
  await call("obs-set-current-scene", { sceneName: currentProgramSceneName });
  if (!hadPreviewScene) {
    await call("obs-remove-scene", { sceneName: "Design Preview" });
  }
}

await client.close();
console.log(failed ? "SMOKE TEST FAILED" : `Smoke test passed. Screenshots in ${outDir}`);
process.exit(failed ? 1 : 0);
