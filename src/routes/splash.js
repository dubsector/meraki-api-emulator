// Splash page themes. The system themes are a fixed read-only list; custom
// themes start empty or as a copy of a base theme's assets. Assets are kept as
// base64 and answered the way the dashboard encodes them, in 60 character lines.
// SSID splash settings name a theme by themeId (wireless.js checks it on write
// and reads a gone theme as null), so a theme in use can't be deleted.

import { badRequest, notFound } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { orgOf } from './common.js';

const THEMES = '/organizations/{organizationId}/splash/themes';
const ASSET = '/organizations/{organizationId}/splash/assets/{id}';
const MAX_THEMES = 50;
const MAX_ASSETS = 25;
// Base64 characters kept across an organization's custom themes.
const MAX_BYTES = 5 * 1024 * 1024;

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

const SYSTEM = ['Modern', 'Classic', 'Minimal'].map((name) => {
  const r = new Rand(hashStr(`meraki-api-emulator:splashTheme:${name}`));
  const page = (title) => `<html><head><title>${title}</title><link rel="stylesheet" href="style.css"></head><body class="${name.toLowerCase()}">{{content}}</body></html>\n`;
  return {
    id: r.hex(40),
    name,
    assets: [
      { name: 'continue.html', data: b64(page('Continue')) },
      { name: 'click_through.html', data: b64(page('Welcome')) },
      { name: 'sign_on.html', data: b64(page('Sign on')) },
      { name: 'style.css', data: b64(`body.${name.toLowerCase()} { font-family: sans-serif; margin: 2em; }\n`) },
    ].map((a) => ({ id: r.digits(13), ...a })),
  };
});

export const themesOf = (org) => (org.splashThemes ??= { created: 0, assets: 0, list: [] });
const allThemes = (org) => [...SYSTEM, ...themesOf(org).list];
const isSystem = (t) => SYSTEM.includes(t);

// The theme a themeId names in an organization, or nothing.
export const themeIn = (org, id) => (id == null ? null : allThemes(org).find((t) => t.id === id) ?? null);

// Strict base64 with whitespace allowed, as a JSON body carries a file.
export function base64Of(v, name) {
  const s = typeof v === 'string' ? v.replace(/\s+/g, '') : '';
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw badRequest(`'${name}' must be a base64 encoded file`);
  return s;
}

const fileData = (data) => data.match(/.{1,60}/g).join('\n') + '\n';
const themeJson = (t) => ({ id: t.id, name: t.name, isSystemTheme: isSystem(t), themeAssets: t.assets.map((a) => ({ id: a.id, name: a.name })) });

// Splash settings naming a theme, in the organization's networks and templates.
function themeUsers(org, id) {
  const configs = [...org.networks.filter((n) => !n.template).map((n) => n.config), ...(org.configTemplates?.list ?? []).map((t) => t.config)];
  return configs.filter((c) => Object.values(c?.splash ?? {}).some((s) => s.themeId === id)).length;
}

// A network whose SSIDs show a custom theme can't move to another organization.
export function usesSplashThemes(net) {
  const custom = new Set(themesOf(net.org).list.map((t) => t.id));
  return Object.values(net.config?.splash ?? {}).some((s) => custom.has(s.themeId));
}

function findAsset(ctx) {
  const org = orgOf(ctx);
  for (const t of allThemes(org)) {
    const a = t.assets.find((x) => x.id === ctx.params.id);
    if (a) return { org, theme: t, asset: a };
  }
  throw notFound('Splash theme asset');
}

function newAssetId(ctx, org, store) {
  const taken = new Set(allThemes(org).flatMap((t) => t.assets.map((a) => a.id)));
  store.assets++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:splashAsset:${org.id}:${store.assets}`));
  let id;
  do id = r.digits(13);
  while (taken.has(id));
  return id;
}

const storedBytes = (store) => store.list.reduce((n, t) => n + t.assets.reduce((m, a) => m + a.data.length, 0), 0);

function createTheme(ctx) {
  const org = orgOf(ctx);
  const store = themesOf(org);
  const b = ctx.body;
  if (store.list.length >= MAX_THEMES) throw badRequest(`Organizations are limited to ${MAX_THEMES} custom splash themes in the emulator`);
  if (b.name == null || !String(b.name).trim()) throw badRequest("'name' is required");
  if (allThemes(org).some((t) => t.name === b.name)) throw badRequest(`A splash theme named '${b.name}' already exists in this organization`);
  const base = b.baseTheme == null ? null : themeIn(org, b.baseTheme);
  if (b.baseTheme != null && !base) throw badRequest("'baseTheme' must be the ID of a splash theme in this organization");
  const size = base ? base.assets.reduce((n, a) => n + a.data.length, 0) : 0;
  if (storedBytes(store) + size > MAX_BYTES) throw badRequest('Splash theme assets are limited to 5 MB per organization in the emulator');
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:splashTheme:${org.id}:${store.created}`));
  let id;
  do id = r.hex(40);
  while (themeIn(org, id));
  const theme = { id, name: b.name, assets: [] };
  for (const a of base?.assets ?? []) theme.assets.push({ id: newAssetId(ctx, org, store), name: a.name, data: a.data });
  store.list.push(theme);
  return themeJson(theme);
}

function deleteTheme(ctx) {
  const org = orgOf(ctx);
  const store = themesOf(org);
  const t = themeIn(org, ctx.params.id);
  if (!t) throw notFound('Splash theme');
  if (isSystem(t)) throw badRequest('System splash themes cannot be deleted');
  const users = themeUsers(org, t.id);
  if (users) throw badRequest(`The splash theme '${t.name}' is used by the splash settings of ${users} network${users === 1 ? '' : 's'} or template${users === 1 ? '' : 's'}`);
  store.list.splice(store.list.indexOf(t), 1);
}

// A file with the name of one the theme already has replaces it and keeps its ID.
function createAsset(ctx) {
  const org = orgOf(ctx);
  const store = themesOf(org);
  const id = ctx.params.themeIdentifier;
  const t = themeIn(org, id) ?? store.list.find((x) => x.name === id);
  if (!t) throw notFound('Splash theme');
  if (isSystem(t)) throw badRequest('System splash themes cannot be changed');
  const { name, content } = ctx.body;
  if (name == null || !String(name).trim()) throw badRequest("'name' is required");
  if (/[/\\]/.test(name) || name === '.' || name === '..') throw badRequest("'name' must be a file name");
  if (content == null) throw badRequest("'content' is required");
  const data = base64Of(content, 'content');
  const old = t.assets.find((a) => a.name === name);
  if (!old && t.assets.length >= MAX_ASSETS) throw badRequest(`Splash themes are limited to ${MAX_ASSETS} assets in the emulator`);
  if (storedBytes(store) - (old?.data.length ?? 0) + data.length > MAX_BYTES) throw badRequest('Splash theme assets are limited to 5 MB per organization in the emulator');
  const asset = old ?? { id: newAssetId(ctx, org, store), name, data: '' };
  asset.data = data;
  if (!old) t.assets.push(asset);
  return { id: asset.id, name: asset.name, fileData: fileData(asset.data) };
}

export default [
  {
    op: 'getOrganizationSplashThemes',
    path: THEMES,
    handler: (ctx) => allThemes(orgOf(ctx)).map(themeJson),
  },
  { op: 'createOrganizationSplashTheme', method: 'POST', path: THEMES, handler: createTheme },
  { op: 'deleteOrganizationSplashTheme', method: 'DELETE', path: `${THEMES}/{id}`, handler: deleteTheme },
  { op: 'createOrganizationSplashThemeAsset', method: 'POST', path: `${THEMES}/{themeIdentifier}/assets`, handler: createAsset },
  {
    op: 'getOrganizationSplashAsset',
    path: ASSET,
    sample: { id: SYSTEM[0].assets[0].id },
    handler: (ctx) => {
      const { asset: a } = findAsset(ctx);
      return { id: a.id, name: a.name, fileData: fileData(a.data) };
    },
  },
  {
    op: 'deleteOrganizationSplashAsset',
    method: 'DELETE',
    path: ASSET,
    // The first custom theme's first asset, when there is one.
    sample: { id: (world) => world.orgs.flatMap((o) => o.splashThemes?.list ?? []).find((t) => t.assets.length)?.assets[0].id ?? SYSTEM[0].assets[0].id },
    handler: (ctx) => {
      const { theme, asset } = findAsset(ctx);
      if (isSystem(theme)) throw badRequest('Assets of system splash themes cannot be deleted');
      theme.assets.splice(theme.assets.indexOf(asset), 1);
    },
  },
];
