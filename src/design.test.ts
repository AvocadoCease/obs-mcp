import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const designDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-mcp-designs-'));
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-mcp-fixtures-'));
process.env.OBS_MCP_DESIGN_DIR = designDir;

let resolveDesign: typeof import('./tools/design.js').resolveDesign;
let describeError: typeof import('./client.js').describeError;

beforeAll(async () => {
  ({ resolveDesign } = await import('./tools/design.js'));
  ({ describeError } = await import('./client.js'));
});

describe('resolveDesign', () => {
  it('writes raw HTML to the design folder with a UTF-8 charset', async () => {
    const design = await resolveDesign('Lower Third!', { html: '<html><head></head><body>Guest · Analyst</body></html>' });
    expect(design.kind).toBe('browser_source');
    expect(design.target).toBe(path.join(designDir, 'lower-third', 'index.html'));
    expect(fs.readFileSync(design.target, 'utf8')).toContain('<head><meta charset="utf-8">');
  });

  it('unpacks a zip export and finds index.html inside a wrapper folder', async () => {
    const src = path.join(fixtures, 'zip-src', 'my-overlay');
    fs.mkdirSync(path.join(src, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(src, 'index.html'), '<p>hi</p>');
    fs.writeFileSync(path.join(src, 'assets', 'style.css'), 'p{}');
    const zip = path.join(fixtures, 'export.zip');
    execFileSync('zip', ['-qr', zip, 'my-overlay'], { cwd: path.join(fixtures, 'zip-src') });

    const design = await resolveDesign('scoreboard', { path: zip });
    expect(design.kind).toBe('browser_source');
    expect(design.target).toBe(path.join(designDir, 'scoreboard', 'my-overlay', 'index.html'));
    expect(design.watchPath).toBe(path.join(designDir, 'scoreboard'));
    expect(fs.readFileSync(design.target, 'utf8').startsWith('<meta charset="utf-8">')).toBe(true);
  });

  it('loads a folder in place without modifying the user\'s files', async () => {
    const folder = path.join(fixtures, 'folder-design');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'card.html'), '<p>card</p>');

    const design = await resolveDesign('card', { path: folder });
    expect(design.target).toBe(path.join(folder, 'card.html'));
    expect(fs.readFileSync(design.target, 'utf8')).toBe('<p>card</p>');
  });

  it('maps images and videos to the matching OBS source', async () => {
    const png = path.join(fixtures, 'graphic.PNG');
    const mp4 = path.join(fixtures, 'loop.mp4');
    fs.writeFileSync(png, '');
    fs.writeFileSync(mp4, '');
    expect((await resolveDesign('g', { path: png })).kind).toBe('image_source');
    expect((await resolveDesign('v', { path: mp4 })).kind).toBe('ffmpeg_source');
  });

  it('passes URLs straight through to a browser source', async () => {
    const design = await resolveDesign('remote', { url: 'https://example.com/overlay' });
    expect(design).toMatchObject({ kind: 'browser_source', isUrl: true, target: 'https://example.com/overlay' });
  });

  it('rejects unsupported files and ambiguous input', async () => {
    const pdf = path.join(fixtures, 'deck.pdf');
    fs.writeFileSync(pdf, '');
    await expect(resolveDesign('deck', { path: pdf })).rejects.toThrow('Unsupported file type ".pdf"');
    await expect(resolveDesign('x', { html: '<p></p>', url: 'https://example.com' })).rejects.toThrow('exactly one');
    await expect(resolveDesign('x', {})).rejects.toThrow('exactly one');
  });
});

describe('describeError', () => {
  it('explains refused connections that Node reports with an empty message', () => {
    const refused = Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:4455')], ''), { code: 'ECONNREFUSED' });
    expect(describeError(refused)).toBe('ECONNREFUSED');
    expect(describeError(new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:4455')], ''))).toBe('connect ECONNREFUSED 127.0.0.1:4455');
    expect(describeError(new Error('boom'))).toBe('boom');
  });
});
