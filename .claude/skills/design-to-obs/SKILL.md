---
name: design-to-obs
description: Put a design (from Claude Design, HTML you write, an image, a video or a URL) into OBS Studio and check how it looks on the stream straight away. Use when the user wants to test, preview, try out, iterate on or go live with an overlay, lower third, scoreboard, graphic, title card, background or any stream visual in OBS, or says things like "put this in OBS", "how does this look on stream", "load my Claude Design export".
---

# Design → OBS

Uses the `obs` MCP server's `obs-design-*` tools. Each design becomes an OBS source named `Design: <name>` on a
`Design Preview` scene. Every tool returns a screenshot of the result, so look at it and judge it yourself before
reporting back.

## 1. Get the design

Work out what the user is handing over and pass exactly one of these to `obs-design-preview`:

| They have | Pass |
| --- | --- |
| A Claude Design export (.zip or .html) | `path` to the file. If they say "the one I just exported", use the newest `.zip`/`.html` in `~/Downloads` and say which file you picked. |
| A folder with `index.html` | `path` to the folder |
| An image (PNG/JPG/GIF/WebP), including one attached to the chat | `path` to the image file |
| A video loop (MP4/MOV/WebM) | `path` |
| A hosted overlay (overlays.uno, a local dev server) | `url` |
| A design described in chat that you should build | `html`: write a single self-contained page |

When writing HTML yourself:
- Size the page to the OBS canvas (1920×1080 unless the tool output says otherwise), with `<meta charset="utf-8">`.
- Leave the body background transparent so it overlays the show. Put opaque panels only where the graphic is.
- Keep text inside broadcast-safe margins (about 5% from each edge) and make it readable at stream bitrates: bold
  weights, at least 28px for secondary text, strong contrast.
- CSS animations are fine. Avoid anything that needs user interaction.

## 2. Preview it

Call `obs-design-preview` with a short `name` (reuse the same name to update a design in place).

- To see it in context, pass `backgroundScene` with the show scene it's meant for (use `obs-get-scene-list` to
  find names). Without it, transparent areas show as blank in the screenshot.
- For animated graphics, set `frames` (2–4) and `frameIntervalMs` to capture it mid-animation and at rest.
- `show` switches OBS to the preview scene. The tool never switches the live program while streaming or recording.
  If they are live and want to preview, tell them to enable Studio Mode.

Then **look at the screenshot** and check:
- Text is legible, nothing is clipped or overflowing, and nothing sits off-canvas.
- It doesn't cover the important parts of the scene underneath (faces, camera boxes, scoreboards).
- Fonts actually loaded (fallback system fonts suggest a broken font link).
- Characters render correctly. If the result warns about a missing charset, fix the HTML.

Fix any problems you can see before reporting back, then tell the user what you checked.

## 3. Iterate

- If the design came from a file or folder, it's watched: when the user (or you) saves changes, OBS reloads it.
  Use `obs-design-screenshot` with `sceneName: "Design Preview"` to look again after an edit.
- If you wrote the HTML, call `obs-design-preview` again with the same `name` and the new `html`.
- If they re-export from Claude Design, call `obs-design-preview` again with the new file path.
- `obs-design-refresh` forces a reload if something looks stale (e.g. a cached web font or image).

## 4. Use it in the show

When they're happy, call `obs-design-add-to-scene` with the show scene name. It shares the same source, so later
edits appear in every scene that uses it. Confirm from the returned screenshot that it sits correctly over the scene.

`obs-design-list` shows what's loaded. `obs-design-remove` deletes a design's source from every scene, so only use it
when they ask, and never on a design that's in a scene they're live on.

## If OBS isn't reachable

The tools report this clearly. Ask the user to open OBS and check Tools → WebSocket Server Settings →
"Enable WebSocket server". The password is read from the local OBS config automatically, so no other setup is needed.

## Changing the tools themselves

If the user wants the `obs-design-*` tools to behave differently (a new option, a bug fix), change the server's
source code. Run `claude mcp get obs`: the server's args point to `<repo>/build/index.js`, and the repo root is the
folder above `build`. Edit the TypeScript in `<repo>/src` (the design tools are in `src/tools/design.ts`), then run
`npm run build` and `npm test` in the repo. The running server keeps the old code until it restarts, so ask the user
to reconnect it with `/mcp` or start a new session before testing the change.
