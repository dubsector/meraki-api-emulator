import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { endpointsMarkdown } from '../scripts/endpoints.js';
import { ROUTES } from '../src/server.js';

test('ENDPOINTS.md lists every route (run npm run docs to update it)', () => {
  assert.equal(readFileSync(new URL('../ENDPOINTS.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n'), endpointsMarkdown());
});

test('every route has a unique operation ID', () => {
  const ops = ROUTES.map((r) => r.op);
  assert.ok(ops.every(Boolean));
  assert.equal(new Set(ops).size, ops.length);
});

test('wiki links name pages in docs/wiki', () => {
  const dir = new URL('../docs/wiki/', import.meta.url);
  const pages = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  const read = (url) => readFileSync(url, 'utf8');
  const docs = [['README.md', read(new URL('../README.md', import.meta.url))], ...pages.map((p) => [p, read(new URL(`${p}.md`, dir))])];
  for (const [name, text] of docs) {
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const wiki = target.match(/^https:\/\/github\.com\/dubsector\/meraki-api-emulator\/wiki\/([^#]+)/);
      const page = wiki ? wiki[1] : name !== 'README.md' && !/^(https?:|#)/.test(target) && target.split('#')[0];
      if (page) assert.ok(pages.includes(page), `${name} links to a missing wiki page: ${target}`);
    }
  }
  const sidebar = read(new URL('_Sidebar.md', dir));
  for (const p of pages.filter((p) => !p.startsWith('_'))) assert.ok(sidebar.includes(`](${p})`), `_Sidebar.md leaves out ${p}`);
});
