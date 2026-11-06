import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';

const IDS = ['movidesk', 'azure-devops', 'waha'];
const manifest = (id) => JSON.parse(fs.readFileSync(`runtime/src/plugins/${id}/plugin.json`, 'utf8'));

test('every sample plugin has a UI half registered under its manifest id', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { UI_PLUGINS } = await server.ssrLoadModule('/src/plugins/index.ts');
    for (const id of IDS) {
      assert.equal(typeof UI_PLUGINS[id], 'function', id + ' is registered');
      const ui = (await server.ssrLoadModule(`/src/plugins/${id}/index.tsx`)).default;
      const m = manifest(id);
      // every UI component maps to something the manifest declares, and every declared view has a component
      for (const v of Object.keys(ui.views ?? {})) assert.ok(m.contributes.views?.some((d) => d.id === v), `${id}: view ${v} is declared`);
      for (const v of m.contributes.views ?? []) assert.equal(typeof ui.views?.[v.id], 'function', `${id}: view ${v.id} has a component`);
      for (const t of Object.keys(ui.taskSources ?? {})) assert.ok(m.contributes.taskSources?.some((d) => d.id === t));
    }
  } finally { await server.close(); }
});

test('Movidesk and Azure DevOps use the generic task-source view; WAHA contributes a nav view', () => {
  for (const id of ['movidesk', 'azure-devops']) {
    const m = manifest(id);
    assert.equal(m.scope, 'user');
    assert.deepEqual(m.contributes.taskSources.map((s) => s.view), ['generic']);
    assert.ok(m.secrets.every((s) => s.required));
    assert.deepEqual(m.contributes.views ?? [], []);
  }
  const waha = manifest('waha');
  assert.equal(waha.scope, 'install');
  assert.deepEqual(waha.contributes.views.map((v) => [v.id, v.label]), [['inbox', 'WhatsApp']]);
  assert.deepEqual(waha.contributes.webhooks, ['events']);
});

test('sample plugin icons exist in the curated icon map', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { PLUGIN_ICONS } = await server.ssrLoadModule('/src/plugins/icons.ts');
    for (const id of IDS) { const m = manifest(id); for (const name of [m.icon, ...(m.contributes.views ?? []).map((v) => v.icon)].filter(Boolean)) assert.ok(PLUGIN_ICONS[name], `${id}: ${name}`); }
  } finally { await server.close(); }
});

test('the WAHA view handles loading, forbidden, not-configured and error through the kit, and sends only on click', () => {
  const src = fs.readFileSync('src/plugins/waha/inbox-view.tsx', 'utf8');
  for (const state of ['state="loading"', 'state="error"', 'state="not-configured"', 'state="empty"']) assert.ok(src.includes(state), state);
  assert.match(src, /statusOf\(e\) === 403/);
  assert.match(src, /void send\(\)/); // sending is wired to the form submit and the button, never to an effect or event
  assert.doesNotMatch(src, /useEffect\([^)]*send\(/);
  assert.match(src, /usePluginEvent</); // live updates
  assert.doesNotMatch(src, /from "@\/(components|lib)\//); // kit only
});

test('plugin toasts reach the host on any screen and ignore malformed frames', async () => {
  const { dispatchPluginFrame, subscribePluginToasts } = await import('../src/plugins/events.ts');
  const got = [];
  const off = subscribePluginToasts((t) => got.push(t));
  dispatchPluginFrame({ type: 'plugin', pluginId: 'waha', name: 'toast', data: { title: 'WhatsApp: Ana', description: 'Oi' } });
  dispatchPluginFrame({ type: 'plugin', pluginId: 'waha', name: 'toast', data: { title: 5 } });
  dispatchPluginFrame({ type: 'plugin', pluginId: 'waha', name: 'toast', data: null });
  dispatchPluginFrame({ type: 'plugin', pluginId: 'waha', name: 'toast', data: { title: 'x'.repeat(500), description: 'd'.repeat(500) } });
  off();
  dispatchPluginFrame({ type: 'plugin', pluginId: 'waha', name: 'toast', data: { title: 'after off' } });
  assert.deepEqual(got.map((t) => [t.pluginId, t.title.length, t.description?.length]), [['waha', 13, 2], ['waha', 120, 300]]);
  assert.equal(got[0].title, 'WhatsApp: Ana');
});

test('WAHA: its nav entry shows only for the user the server says can use it (owner-only access)', async () => {
  const { activeContributions } = await import('../src/plugins/registry.ts');
  const m = JSON.parse(fs.readFileSync('runtime/src/plugins/waha/plugin.json', 'utf8'));
  assert.equal(m.access, 'owner');
  const info = (userEnabled) => ({ id: 'waha', name: m.name, version: m.version, description: m.description, scope: 'install', status: 'enabled', enabled: true, userEnabled, secrets: [], settings: [], contributes: { views: m.contributes.views, taskSources: [], rightSidebarTabs: [], settingsPanel: false } });
  const ui = { waha: { views: { inbox: () => null } } };
  assert.deepEqual(activeContributions([info(true)], ui).views.map((v) => `${v.pluginId}/${v.viewId}`), ['waha/inbox']); // the admin who set it up
  assert.deepEqual(activeContributions([info(false)], ui).views, []); // everyone else: no nav entry
});
