import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OBSWebSocketClient } from "../client.js";

// Import specific tool modules
import * as general from "./general.js";
import * as scenes from "./scenes.js";
import * as sources from "./sources.js";
import * as sceneItems from "./scene-items.js";
import * as streaming from "./streaming.js";
import * as transitions from "./transitions.js";
import * as config from "./config.js";
import * as filters from "./filters.js";
import * as inputs from "./inputs.js";
import * as mediaInputs from "./media-inputs.js";
import * as outputs from "./outputs.js";
import * as record from "./record.js";
import * as ui from "./ui.js";
import * as design from "./design.js";

const toolsets = {
  general,
  scenes,
  sources,
  "scene-items": sceneItems,
  streaming,
  transitions,
  config,
  filters,
  inputs,
  "media-inputs": mediaInputs,
  outputs,
  record,
  ui,
  design,
};

type ToolsetName = keyof typeof toolsets;

/**
 * OBS_MCP_TOOLSETS limits which tool groups are registered (comma separated, e.g. "design,scenes,sources").
 * Fewer tools keeps the model's context small and makes it pick the right tool more often. Default: all.
 */
function enabledToolsets(): ToolsetName[] {
  const all = Object.keys(toolsets) as ToolsetName[];
  const requested = process.env.OBS_MCP_TOOLSETS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!requested || requested.includes("all")) {
    return all;
  }
  const unknown = requested.filter((name) => !all.includes(name as ToolsetName));
  if (unknown.length) {
    console.error(`Ignoring unknown OBS_MCP_TOOLSETS entries: ${unknown.join(", ")}. Valid: ${all.join(", ")}`);
  }
  return all.filter((name) => requested.includes(name));
}

// Export the initialization function for all tools
export async function initialize(server: McpServer, client: OBSWebSocketClient): Promise<void> {
  await Promise.all(enabledToolsets().map((name) => toolsets[name].initialize(server, client)));
}

// Release anything tools hold open (file watchers) before exit
export async function shutdown(): Promise<void> {
  await design.shutdown();
}

// Export tool modules
export {
  general,
  scenes,
  sources,
  sceneItems,
  streaming,
  transitions,
  config,
  filters,
  inputs,
  mediaInputs,
  outputs,
  record,
  ui,
  design
};
