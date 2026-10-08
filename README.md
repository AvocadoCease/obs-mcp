# OBS MCP Server

An MCP server for OBS Studio that lets Claude control OBS through the OBS WebSocket protocol, and preview designs
(overlays, lower thirds, graphics, video loops) in OBS straight away.

## Features

- Design preview: send HTML, a Claude Design export (.zip/.html), an image, a video or a URL to OBS, see a
  screenshot of the result, and have OBS reload it automatically when the files change
- Screenshots come back as images, so Claude can see what OBS is outputting
- Tools for scenes, sources, scene items, inputs, filters, transitions, streaming, recording and more
- Connects as soon as OBS is available and reconnects if OBS restarts, without restarting the MCP server
- Reads the WebSocket password from the local OBS install, so no secrets in your MCP config

## Setup

1. In OBS, open **Tools → WebSocket Server Settings** and tick **Enable WebSocket server**.
2. Build the server:

   ```bash
   npm install
   npm run build
   ```

3. Add it to Claude Code:

   ```bash
   claude mcp add obs --scope user -- node "$(pwd)/build/index.js"
   ```

   Or Claude Desktop (`claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "obs": {
         "command": "node",
         "args": ["<obs-mcp_root>/build/index.js"]
       }
     }
   }
   ```

4. With OBS open, check everything works end to end:

   ```bash
   npm run smoke
   ```

   This loads a test overlay into a `Design Preview` scene, edits it on disk to check live reload, then removes it.

## Design preview workflow

Ask Claude something like "put my lower third export from Downloads into OBS over the Benchmarkers scene". The
`design-to-obs` skill in `.claude/skills/` guides Claude through it. To use it outside this repo, link it into your
user skills:

```bash
ln -s "$(pwd)/.claude/skills/design-to-obs" ~/.claude/skills/design-to-obs
```

| Tool | What it does |
| --- | --- |
| `obs-design-preview` | Load HTML / file / folder / .zip / URL into a `Design: <name>` source on the `Design Preview` scene, optionally over an existing show scene (`backgroundScene`), watch it for changes and return screenshots (`frames` > 1 for animations) |
| `obs-design-screenshot` | Screenshot the program scene or any scene/source |
| `obs-design-refresh` | Force a reload (browser cache cleared, videos restarted) |
| `obs-design-add-to-scene` | Put a previewed design into a real show scene, sharing the same source |
| `obs-design-list` / `obs-design-remove` | See or delete loaded designs |

While OBS is streaming or recording, previews never switch the live program scene. Enable Studio Mode to preview
designs while live.

Designs passed as raw HTML or .zip are written to `OBS_MCP_DESIGN_DIR`. Files and folders on disk are loaded in place.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OBS_WEBSOCKET_URL` | Port from the local OBS config, else `ws://localhost:4455` | WebSocket address (set this when OBS runs on another machine) |
| `OBS_WEBSOCKET_PASSWORD` | Password from the local OBS config | Needed only when OBS runs on another machine |
| `OBS_MCP_TOOLSETS` | all | Comma-separated tool groups to load, e.g. `design,scenes,scene-items,sources,streaming,record`. Valid: `general`, `scenes`, `sources`, `scene-items`, `streaming`, `transitions`, `config`, `filters`, `inputs`, `media-inputs`, `outputs`, `record`, `ui`, `design` |
| `OBS_MCP_DESIGN_DIR` | `~/obs-mcp-designs` | Where HTML and unpacked .zip designs are stored |

## Development

```bash
npm run build   # compile TypeScript
npm test        # unit tests (run after build)
npm run smoke   # end-to-end check against a running OBS
```

## Requirements

- Node.js 18+
- OBS Studio 30+ with the WebSocket server enabled
- Claude Code or Claude Desktop
- `unzip` on the PATH for .zip exports (built in on macOS and most Linux distributions)

## License

See the [LICENSE](LICENSE) file for details.
