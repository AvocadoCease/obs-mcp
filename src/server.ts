import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import os from "os";
import path from "path";
import { OBSWebSocketClient } from "./client.js";
import * as tools from "./tools/index.js";

const logger = {
  log: (message: string) => console.error(message),
  error: (message: string) => console.error(message),
  debug: (message: string) => console.error(message),
};

/**
 * Where obs-websocket keeps its settings for the current platform
 */
function obsWebSocketConfigPath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json");
    case "win32":
      return path.join(process.env.APPDATA || path.join(home, "AppData/Roaming"), "obs-studio/plugin_config/obs-websocket/config.json");
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "obs-studio/plugin_config/obs-websocket/config.json");
  }
}

/**
 * Use OBS_WEBSOCKET_URL / OBS_WEBSOCKET_PASSWORD when set, otherwise read them from the local OBS install
 * so the server works without copying the password into MCP config.
 */
function resolveConnectionSettings(): { url: string; password: string | null } {
  let url = process.env.OBS_WEBSOCKET_URL || null;
  let password = process.env.OBS_WEBSOCKET_PASSWORD || null;

  if (!url || !password) {
    try {
      const config = JSON.parse(fs.readFileSync(obsWebSocketConfigPath(), "utf8"));
      if (!url && config.server_port) {
        url = `ws://localhost:${config.server_port}`;
      }
      if (!password && config.auth_required && config.server_password) {
        password = config.server_password;
        logger.log("Using WebSocket password from the local OBS config");
      }
      if (config.server_enabled === false) {
        logger.error("The OBS WebSocket server is disabled. Enable it in OBS: Tools > WebSocket Server Settings.");
      }
    } catch {
      // No local OBS config (e.g. OBS on another machine) - fall back to defaults
    }
  }

  return { url: url || "ws://localhost:4455", password };
}

const connectionSettings = resolveConnectionSettings();

// Create the OBS WebSocket client
const obsClient = new OBSWebSocketClient(connectionSettings.url, connectionSettings.password);

// Create the MCP server
export const server = new McpServer({
  name: "obs-mcp",
  version: "1.0.1",
});

export let serverConnected = false;
export let obsConnected = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let shuttingDown = false;
const RECONNECT_INTERVAL = 2000;
const MAX_BACKOFF_INTERVAL = 15000;

// Attempt an OBS connection, scheduling a retry with backoff on failure.
// Tool calls also connect on demand, so a retry pending in the background never blocks a request.
async function attemptOBSConnection(): Promise<void> {
  reconnectTimer = null;
  try {
    await obsClient.connect();
    obsConnected = true;
    reconnectAttempts = 0;
    logger.log("Connected to OBS WebSocket server");
  } catch (obsError) {
    obsConnected = false;
    reconnectAttempts++;

    if (reconnectAttempts === 1) {
      const errorMessage = obsError instanceof Error ? obsError.message : String(obsError);
      logger.error(`Failed to connect to OBS WebSocket: ${errorMessage}`);
      logger.error("The server will continue running and connect as soon as OBS is available.");
      logger.error(`Make sure OBS Studio is running with the WebSocket server enabled (${connectionSettings.url})`);
    }

    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || shuttingDown) {
    return;
  }
  const delay = Math.min(RECONNECT_INTERVAL * Math.pow(1.5, Math.min(reconnectAttempts, 6)), MAX_BACKOFF_INTERVAL);
  reconnectTimer = setTimeout(attemptOBSConnection, delay);
}

obsClient.on("identified", () => {
  obsConnected = true;
  reconnectAttempts = 0;
});

obsClient.on("disconnected", () => {
  logger.log("OBS WebSocket disconnected, will attempt to reconnect...");
  obsConnected = false;
  scheduleReconnect();
});

// Set up server startup logic
export async function startServer() {
  try {
    // Initialize all tools with the OBS client
    await tools.initialize(server, obsClient);
    logger.log("Initialized MCP tools");

    // Connect the MCP server to stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.log("OBS MCP Server running on stdio");

    serverConnected = true;

    // Set up graceful shutdown
    process.on("SIGINT", handleShutdown);
    process.on("SIGTERM", handleShutdown);
    process.stdin.on("close", handleShutdown);

    // Try to connect to OBS WebSocket (but don't fail if it's not available)
    await attemptOBSConnection();

    logger.log("Server startup complete");
    logger.log(obsConnected ? "✅ OBS WebSocket: Connected" : "❌ OBS WebSocket: Disconnected (will retry automatically)");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error starting server: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
      logger.error(`Stack trace: ${error.stack}`);
    }
    process.exit(1);
  }
}

// Handle graceful shutdown
async function handleShutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.log("Shutting down...");

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  await tools.shutdown();
  obsClient.disconnect();

  process.exit(0);
}

export { obsClient };
