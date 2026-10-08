import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { z } from "zod";
import { OBSWebSocketClient } from "../client.js";
import { captureScreenshot } from "../screenshot.js";

const execFileAsync = promisify(execFile);

const logger = {
  log: (message: string) => console.error(message),
  error: (message: string) => console.error(message),
};

// Where designs passed as raw HTML or zip exports are unpacked
const DESIGN_DIR = process.env.OBS_MCP_DESIGN_DIR || path.join(os.homedir(), "obs-mcp-designs");
const DEFAULT_PREVIEW_SCENE = "Design Preview";
const SOURCE_PREFIX = "Design: ";

// Keeps the page background see-through so overlays composite over the scene beneath them
const TRANSPARENT_CSS = "html, body { background-color: rgba(0, 0, 0, 0) !important; margin: 0px auto; overflow: hidden; }";
const DEFAULT_BROWSER_CSS = "body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }";

const HTML_EXTENSIONS = new Set([".html", ".htm", ".svg"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tga"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

type DesignKind = "browser_source" | "image_source" | "ffmpeg_source";

interface ResolvedDesign {
  kind: DesignKind;
  // Local file to load, or a remote URL for browser sources
  target: string;
  isUrl: boolean;
  // File or directory to watch for edits, if any
  watchPath?: string;
}

interface DesignState {
  inputName: string;
  kind: DesignKind;
  target: string;
  watcher?: fs.FSWatcher;
}

const designs = new Map<string, DesignState>();

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "design";
}

function inputNameFor(name: string): string {
  return name.startsWith(SOURCE_PREFIX) ? name : `${SOURCE_PREFIX}${name}`;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Pick the page to load from an unpacked export: index.html at the top level or inside a single
 * wrapper folder, otherwise the first HTML file found.
 */
export function findEntryHtml(dir: string): string | null {
  const candidates = [path.join(dir, "index.html")];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith(".") && e.name !== "__MACOSX");
  const folders = entries.filter((e) => e.isDirectory());
  if (folders.length === 1 && entries.length === 1) {
    candidates.push(path.join(dir, folders[0].name, "index.html"));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const stack = [dir];
  while (stack.length) {
    const current = stack.shift()!;
    const children = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.name.startsWith(".") || child.name === "__MACOSX" || child.name === "node_modules") continue;
      const full = path.join(current, child.name);
      if (child.isDirectory()) {
        stack.push(full);
      } else if (/\.html?$/i.test(child.name)) {
        return full;
      }
    }
  }
  return null;
}

/**
 * OBS's browser treats local pages without a declared charset as Latin-1, which garbles
 * characters like "·" or "é". Adds a UTF-8 declaration to pages this server owns.
 */
function ensureUtf8(htmlFile: string): void {
  const html = fs.readFileSync(htmlFile, "utf8");
  if (/<meta[^>]+charset/i.test(html)) return;
  const meta = '<meta charset="utf-8">';
  const patched = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (head) => `${head}${meta}`)
    : `${meta}${html}`;
  fs.writeFileSync(htmlFile, patched);
}

function hasCharset(htmlFile: string): boolean {
  return /<meta[^>]+charset/i.test(fs.readFileSync(htmlFile, "utf8"));
}

function kindForFile(file: string): DesignKind {
  const ext = path.extname(file).toLowerCase();
  if (HTML_EXTENSIONS.has(ext)) return "browser_source";
  if (IMAGE_EXTENSIONS.has(ext)) return "image_source";
  if (VIDEO_EXTENSIONS.has(ext)) return "ffmpeg_source";
  throw new Error(
    `Unsupported file type "${ext}". Use HTML/SVG, an image (${[...IMAGE_EXTENSIONS].join(", ")}), ` +
    `a video (${[...VIDEO_EXTENSIONS].join(", ")}), a .zip export or a folder containing index.html.`
  );
}

/**
 * Turn whatever the user handed over (raw HTML, a file, a folder, a zip export or a URL) into something OBS can load
 */
export async function resolveDesign(name: string, input: { html?: string; path?: string; url?: string }): Promise<ResolvedDesign> {
  const provided = [input.html, input.path, input.url].filter((v) => v !== undefined && v !== "");
  if (provided.length !== 1) {
    throw new Error("Provide exactly one of html, path or url.");
  }

  if (input.url) {
    return { kind: "browser_source", target: input.url, isUrl: true };
  }

  const workDir = path.join(DESIGN_DIR, slugify(name));

  if (input.html !== undefined) {
    fs.mkdirSync(workDir, { recursive: true });
    const entry = path.join(workDir, "index.html");
    fs.writeFileSync(entry, input.html);
    ensureUtf8(entry);
    return { kind: "browser_source", target: entry, isUrl: false, watchPath: workDir };
  }

  const source = path.resolve(expandHome(input.path!));
  if (!fs.existsSync(source)) {
    throw new Error(`File not found: ${source}`);
  }

  if (fs.statSync(source).isDirectory()) {
    const entry = findEntryHtml(source);
    if (!entry) throw new Error(`No HTML file found in ${source}`);
    return { kind: "browser_source", target: entry, isUrl: false, watchPath: source };
  }

  if (path.extname(source).toLowerCase() === ".zip") {
    // Unpack into a fresh folder so files removed from a newer export don't linger
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    await execFileAsync("unzip", ["-o", "-q", source, "-d", workDir]);
    const entry = findEntryHtml(workDir);
    if (entry) {
      ensureUtf8(entry);
      return { kind: "browser_source", target: entry, isUrl: false, watchPath: workDir };
    }
    const media = fs.readdirSync(workDir).find((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()));
    if (media) {
      const file = path.join(workDir, media);
      return { kind: "image_source", target: file, isUrl: false, watchPath: file };
    }
    throw new Error(`The zip ${source} has no HTML page or image in it.`);
  }

  return { kind: kindForFile(source), target: source, isUrl: false, watchPath: source };
}

function settingsFor(design: ResolvedDesign, width: number, height: number, transparent: boolean): Record<string, any> {
  switch (design.kind) {
    case "browser_source":
      return {
        is_local_file: !design.isUrl,
        local_file: design.isUrl ? "" : design.target,
        url: design.isUrl ? design.target : "",
        width,
        height,
        css: transparent ? TRANSPARENT_CSS : DEFAULT_BROWSER_CSS,
        reroute_audio: false,
        shutdown: false,
        restart_when_active: false,
      };
    case "image_source":
      return { file: design.target, unload: false };
    case "ffmpeg_source":
      return { is_local_file: true, local_file: design.target, looping: true, restart_on_activate: true, hw_decode: true };
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sceneExists(client: OBSWebSocketClient, sceneName: string): Promise<boolean> {
  const { scenes } = await client.sendRequest("GetSceneList");
  return scenes.some((s: any) => s.sceneName === sceneName);
}

async function ensureScene(client: OBSWebSocketClient, sceneName: string): Promise<void> {
  if (!(await sceneExists(client, sceneName))) {
    await client.sendRequest("CreateScene", { sceneName });
  }
}

async function getInputKind(client: OBSWebSocketClient, inputName: string): Promise<string | null> {
  try {
    const { inputKind } = await client.sendRequest("GetInputSettings", { inputName });
    return inputKind;
  } catch {
    return null;
  }
}

async function findSceneItemId(client: OBSWebSocketClient, sceneName: string, sourceName: string): Promise<number | null> {
  const { sceneItems } = await client.sendRequest("GetSceneItemList", { sceneName });
  const item = sceneItems.find((i: any) => i.sourceName === sourceName);
  return item ? item.sceneItemId : null;
}

async function refreshInput(client: OBSWebSocketClient, inputName: string, kind: DesignKind): Promise<void> {
  if (kind === "browser_source") {
    await client.sendRequest("PressInputPropertiesButton", { inputName, propertyName: "refreshnocache" });
  } else if (kind === "ffmpeg_source") {
    await client.sendRequest("TriggerMediaInputAction", {
      inputName,
      mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
    });
  }
  // Image sources reload by themselves when the file's modified time changes
}

function stopWatching(name: string): void {
  const state = designs.get(name);
  if (state?.watcher) {
    state.watcher.close();
    state.watcher = undefined;
  }
}

/**
 * Reload the design in OBS whenever its files change, so edits show up without asking again
 */
function startWatching(client: OBSWebSocketClient, name: string, watchPath: string): fs.FSWatcher | undefined {
  let debounce: NodeJS.Timeout | null = null;
  // macOS can replay the write that created the file right after the watch starts; ignore that
  const ignoreUntil = Date.now() + 500;
  try {
    const recursive = fs.statSync(watchPath).isDirectory();
    const watcher = fs.watch(watchPath, { recursive }, () => {
      if (Date.now() < ignoreUntil) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const state = designs.get(name);
        if (!state) return;
        try {
          await refreshInput(client, state.inputName, state.kind);
          logger.log(`Reloaded design "${name}" after a file change`);
        } catch (error) {
          logger.error(`Could not reload design "${name}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }, 300);
    });
    watcher.on("error", () => watcher.close());
    return watcher;
  } catch (error) {
    logger.error(`Could not watch ${watchPath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Show the scene in OBS without disrupting a live show: while streaming or recording, the
 * program output is left alone and the scene goes to the Studio Mode preview instead (if enabled).
 */
async function showScene(client: OBSWebSocketClient, sceneName: string): Promise<string> {
  const [{ outputActive: streaming }, { outputActive: recording }, { studioModeEnabled }] = await Promise.all([
    client.sendRequest("GetStreamStatus"),
    client.sendRequest("GetRecordStatus"),
    client.sendRequest("GetStudioModeEnabled"),
  ]);

  if (studioModeEnabled) {
    await client.sendRequest("SetCurrentPreviewScene", { sceneName });
    return `Loaded "${sceneName}" into the Studio Mode preview.`;
  }
  if (streaming || recording) {
    return `OBS is ${streaming ? "streaming" : "recording"}, so the live scene was not switched. Enable Studio Mode to preview designs while live.`;
  }
  await client.sendRequest("SetCurrentProgramScene", { sceneName });
  return `Switched OBS to "${sceneName}".`;
}

async function captureFrames(client: OBSWebSocketClient, sceneName: string, frames: number, intervalMs: number, imageWidth: number) {
  const images = [];
  for (let i = 0; i < frames; i++) {
    if (i > 0) await sleep(intervalMs);
    images.push(await captureScreenshot(client, { sourceName: sceneName, imageWidth }));
  }
  return images;
}

function errorResult(prefix: string, error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${prefix}: ${error instanceof Error ? error.message : String(error)}`
      }
    ],
    isError: true
  };
}

export async function shutdown(): Promise<void> {
  for (const name of designs.keys()) {
    stopWatching(name);
  }
}

export async function initialize(server: McpServer, client: OBSWebSocketClient): Promise<void> {
  server.tool(
    "obs-design-preview",
    "Put a design into OBS and see how it looks. Accepts raw HTML (e.g. an overlay you just wrote), a local " +
    "file (HTML/SVG, PNG/JPG/GIF/WebP, MP4/MOV/WebM), a folder or .zip exported from Claude Design, or a URL. " +
    "The design is loaded into its own source on a preview scene, reloaded automatically whenever its files " +
    "change, and a screenshot of the result is returned. Calling it again with the same name updates the design in place.",
    {
      name: z.string().describe("Short name for the design, e.g. 'lower-third' or 'scoreboard'. Reusing a name updates that design."),
      html: z.string().optional().describe("Raw HTML for the design. Size the page to the OBS canvas (usually 1920x1080)."),
      path: z.string().optional().describe("Path to an HTML/SVG/image/video file, a folder with index.html, or a .zip export"),
      url: z.string().optional().describe("Web page to load, e.g. a hosted overlay or a local dev server"),
      scene: z.string().optional().describe(`Scene to put the design in (default: "${DEFAULT_PREVIEW_SCENE}", created if missing)`),
      backgroundScene: z.string().optional().describe("Existing show scene to place underneath the design, to test it in context (e.g. the scene it will be used in)"),
      width: z.number().optional().describe("Browser page width in pixels (default: OBS canvas width)"),
      height: z.number().optional().describe("Browser page height in pixels (default: OBS canvas height)"),
      fit: z.enum(["contain", "stretch", "none"]).optional().describe("How to size the design on the canvas: contain (default) keeps aspect ratio, stretch fills it, none uses native size at the top-left"),
      transparent: z.boolean().optional().describe("Force a transparent page background for HTML so it overlays the scene (default: true)"),
      solo: z.boolean().optional().describe("Hide other designs in the scene so only this one shows (default: true)"),
      show: z.boolean().optional().describe("Switch OBS to the scene (default: true). Never switches the live program while streaming/recording."),
      watch: z.boolean().optional().describe("Reload in OBS whenever the design's files change (default: true)"),
      waitMs: z.number().optional().describe("How long to let the design load/animate before the screenshot (default: 1500)"),
      frames: z.number().min(1).max(6).optional().describe("Number of screenshots to take, to check animations (default: 1)"),
      frameIntervalMs: z.number().optional().describe("Time between screenshots when frames > 1 (default: 500)"),
    },
    async (args) => {
      try {
        const sceneName = args.scene || DEFAULT_PREVIEW_SCENE;
        const inputName = inputNameFor(args.name);
        const design = await resolveDesign(args.name, args);

        const video = await client.sendRequest("GetVideoSettings");
        const canvasWidth: number = video.baseWidth;
        const canvasHeight: number = video.baseHeight;
        const inputSettings = settingsFor(design, args.width ?? canvasWidth, args.height ?? canvasHeight, args.transparent ?? true);

        await ensureScene(client, sceneName);

        // Reuse the existing source when its type still matches, otherwise rebuild it
        const existingKind = await getInputKind(client, inputName);
        if (existingKind && existingKind !== design.kind) {
          await client.sendRequest("RemoveInput", { inputName });
        }
        let sceneItemId: number | null;
        if (existingKind === design.kind) {
          await client.sendRequest("SetInputSettings", { inputName, inputSettings, overlay: true });
          sceneItemId = await findSceneItemId(client, sceneName, inputName);
          if (sceneItemId === null) {
            ({ sceneItemId } = await client.sendRequest("CreateSceneItem", { sceneName, sourceName: inputName }));
          }
          await refreshInput(client, inputName, design.kind);
        } else {
          ({ sceneItemId } = await client.sendRequest("CreateInput", {
            sceneName,
            inputName,
            inputKind: design.kind,
            inputSettings,
          }));
        }

        // Put the chosen show scene underneath, replacing any background from a previous preview
        if (args.backgroundScene !== undefined) {
          if (args.backgroundScene === sceneName) {
            throw new Error("backgroundScene must be a different scene from the one the design is placed in.");
          }
          const { sceneItems } = await client.sendRequest("GetSceneItemList", { sceneName });
          for (const item of sceneItems) {
            if (item.sourceType === "OBS_SOURCE_TYPE_SCENE" && item.sourceName !== args.backgroundScene) {
              await client.sendRequest("RemoveSceneItem", { sceneName, sceneItemId: item.sceneItemId });
            }
          }
          if (args.backgroundScene) {
            let backgroundId = await findSceneItemId(client, sceneName, args.backgroundScene);
            if (backgroundId === null) {
              ({ sceneItemId: backgroundId } = await client.sendRequest("CreateSceneItem", {
                sceneName,
                sourceName: args.backgroundScene,
              }));
            }
            await client.sendRequest("SetSceneItemIndex", { sceneName, sceneItemId: backgroundId, sceneItemIndex: 0 });
          }
        }

        // Keep the design on top and sized to the canvas
        const { sceneItems } = await client.sendRequest("GetSceneItemList", { sceneName });
        await client.sendRequest("SetSceneItemIndex", { sceneName, sceneItemId, sceneItemIndex: sceneItems.length - 1 });
        await client.sendRequest("SetSceneItemEnabled", { sceneName, sceneItemId, sceneItemEnabled: true });
        if (args.solo ?? true) {
          for (const item of sceneItems) {
            if (item.sceneItemId !== sceneItemId && item.sourceName.startsWith(SOURCE_PREFIX) && item.sceneItemEnabled) {
              await client.sendRequest("SetSceneItemEnabled", { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: false });
            }
          }
        }

        const fit = args.fit || "contain";
        const sceneItemTransform =
          fit === "none"
            ? { positionX: 0, positionY: 0, alignment: 5, scaleX: 1, scaleY: 1, rotation: 0, boundsType: "OBS_BOUNDS_NONE" }
            : {
                positionX: 0,
                positionY: 0,
                alignment: 5,
                rotation: 0,
                boundsType: fit === "stretch" ? "OBS_BOUNDS_STRETCH" : "OBS_BOUNDS_SCALE_INNER",
                boundsAlignment: 0,
                boundsWidth: canvasWidth,
                boundsHeight: canvasHeight,
              };
        await client.sendRequest("SetSceneItemTransform", { sceneName, sceneItemId, sceneItemTransform });

        stopWatching(args.name);
        const watcher = args.watch === false || !design.watchPath ? undefined : startWatching(client, args.name, design.watchPath);
        designs.set(args.name, { inputName, kind: design.kind, target: design.target, watcher });

        const showMessage = args.show === false ? `Design is in "${sceneName}" (scene not switched).` : await showScene(client, sceneName);

        await sleep(args.waitMs ?? 1500);
        const images = await captureFrames(client, sceneName, args.frames ?? 1, args.frameIntervalMs ?? 500, 1280);

        const lines = [
          `Loaded "${inputName}" (${design.kind}) from ${design.target}`,
          showMessage,
          watcher ? `Watching ${design.watchPath} - saving changes reloads it in OBS.` : "Not watching for file changes.",
          `Screenshot${images.length > 1 ? "s" : ""} of "${sceneName}" below (${canvasWidth}x${canvasHeight} canvas).`,
        ];
        if (design.kind === "browser_source" && !design.isUrl && /\.html?$/i.test(design.target) && !hasCharset(design.target)) {
          lines.push('Warning: the page has no <meta charset="utf-8">, so OBS may garble non-ASCII characters. Add it to the <head>.');
        }
        if (!args.backgroundScene) {
          lines.push("Transparent areas show as blank. Pass backgroundScene to see the design over a real show scene.");
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }, ...images] };
      } catch (error) {
        return errorResult("Error previewing design", error);
      }
    }
  );

  server.tool(
    "obs-design-screenshot",
    "See what OBS is showing: screenshots a scene (default: the current program scene) and returns it as an image. " +
    "Take several frames to check animations.",
    {
      sceneName: z.string().optional().describe("Scene or source to capture (default: current program scene)"),
      frames: z.number().min(1).max(6).optional().describe("Number of screenshots to take (default: 1)"),
      intervalMs: z.number().optional().describe("Time between screenshots (default: 500)"),
      imageWidth: z.number().optional().describe("Width of the returned image (default: 1280)"),
    },
    async ({ sceneName, frames, intervalMs, imageWidth }) => {
      try {
        const target = sceneName || (await client.sendRequest("GetCurrentProgramScene")).currentProgramSceneName;
        const images = await captureFrames(client, target, frames ?? 1, intervalMs ?? 500, imageWidth ?? 1280);
        return { content: [{ type: "text" as const, text: `Screenshot of "${target}"` }, ...images] };
      } catch (error) {
        return errorResult("Error taking screenshot", error);
      }
    }
  );

  server.tool(
    "obs-design-refresh",
    "Reload a design in OBS (browser sources are refreshed without cache, videos restart) and return a screenshot",
    {
      name: z.string().describe("Design name used with obs-design-preview"),
      waitMs: z.number().optional().describe("How long to wait before the screenshot (default: 1500)"),
    },
    async ({ name, waitMs }) => {
      try {
        const inputName = inputNameFor(name);
        const kind = (designs.get(name)?.kind || (await getInputKind(client, inputName))) as DesignKind | null;
        if (!kind) throw new Error(`No design called "${name}" in OBS`);
        await refreshInput(client, inputName, kind);
        await sleep(waitMs ?? 1500);
        const image = await captureScreenshot(client, { sourceName: inputName, imageWidth: 1280 });
        return { content: [{ type: "text" as const, text: `Reloaded "${inputName}"` }, image] };
      } catch (error) {
        return errorResult("Error refreshing design", error);
      }
    }
  );

  server.tool(
    "obs-design-list",
    "List designs that have been loaded into OBS and whether they are being watched for changes",
    {},
    async () => {
      try {
        const { inputs } = await client.sendRequest("GetInputList");
        const loaded = inputs
          .filter((i: any) => i.inputName.startsWith(SOURCE_PREFIX))
          .map((i: any) => {
            const name = i.inputName.slice(SOURCE_PREFIX.length);
            const state = designs.get(name);
            return {
              name,
              inputName: i.inputName,
              kind: i.inputKind,
              source: state?.target ?? null,
              watching: Boolean(state?.watcher),
            };
          });
        return {
          content: [{ type: "text" as const, text: loaded.length ? JSON.stringify(loaded, null, 2) : "No designs loaded in OBS." }],
        };
      } catch (error) {
        return errorResult("Error listing designs", error);
      }
    }
  );

  server.tool(
    "obs-design-add-to-scene",
    "Use a previewed design in a real show scene. The design source is shared, so later edits show up everywhere it is used.",
    {
      name: z.string().describe("Design name used with obs-design-preview"),
      sceneName: z.string().describe("Show scene to add the design to"),
      visible: z.boolean().optional().describe("Whether it starts visible in that scene (default: true)"),
    },
    async ({ name, sceneName, visible }) => {
      try {
        const inputName = inputNameFor(name);
        if (!(await getInputKind(client, inputName))) throw new Error(`No design called "${name}" in OBS`);
        if (!(await sceneExists(client, sceneName))) throw new Error(`Scene "${sceneName}" does not exist`);

        let sceneItemId = await findSceneItemId(client, sceneName, inputName);
        if (sceneItemId === null) {
          ({ sceneItemId } = await client.sendRequest("CreateSceneItem", {
            sceneName,
            sourceName: inputName,
            sceneItemEnabled: visible ?? true,
          }));
        } else {
          await client.sendRequest("SetSceneItemEnabled", { sceneName, sceneItemId, sceneItemEnabled: visible ?? true });
        }

        // Match the size/position used in the preview scene
        const previewId = await findSceneItemId(client, DEFAULT_PREVIEW_SCENE, inputName).catch(() => null);
        if (previewId !== null) {
          const { sceneItemTransform } = await client.sendRequest("GetSceneItemTransform", {
            sceneName: DEFAULT_PREVIEW_SCENE,
            sceneItemId: previewId,
          });
          const { width: _w, height: _h, sourceWidth: _sw, sourceHeight: _sh, ...transform } = sceneItemTransform;
          if (transform.boundsWidth < 1 || transform.boundsHeight < 1) {
            delete transform.boundsWidth;
            delete transform.boundsHeight;
          }
          await client.sendRequest("SetSceneItemTransform", { sceneName, sceneItemId, sceneItemTransform: transform });
        }

        const { sceneItems } = await client.sendRequest("GetSceneItemList", { sceneName });
        await client.sendRequest("SetSceneItemIndex", { sceneName, sceneItemId, sceneItemIndex: sceneItems.length - 1 });

        const image = await captureScreenshot(client, { sourceName: sceneName, imageWidth: 1280 });
        return { content: [{ type: "text" as const, text: `Added "${inputName}" to "${sceneName}"` }, image] };
      } catch (error) {
        return errorResult("Error adding design to scene", error);
      }
    }
  );

  server.tool(
    "obs-design-remove",
    "Remove a design from OBS (deletes its source from every scene) and stop watching its files",
    {
      name: z.string().describe("Design name used with obs-design-preview"),
    },
    async ({ name }) => {
      try {
        stopWatching(name);
        designs.delete(name);
        await client.sendRequest("RemoveInput", { inputName: inputNameFor(name) });
        return { content: [{ type: "text" as const, text: `Removed "${inputNameFor(name)}"` }] };
      } catch (error) {
        return errorResult("Error removing design", error);
      }
    }
  );
}
