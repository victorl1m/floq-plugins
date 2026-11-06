# Writing a Floq plugin

Plugins extend Floq through declared contribution points only. This guide covers **Tier 1 (core) plugins**: written by Floq maintainers, reviewed like core code, compiled into the runtime and the app. Third-party (Tier 2) plugins are reserved in the manifest (`tier`, `apiVersion`) but not supported yet.

Start from the dev-only example: `runtime/src/plugins/example/` and `src/plugins/example/` (enable it with `FLOQ_DEV_PLUGINS=1` for the runtime; dev builds of the app load the UI half).

## 1. Layout

A plugin has a runtime half and a UI half linked by its `id`. They build separately (`runtime/` cannot see `src/`).

```
runtime/src/plugins/<id>/index.ts    definePlugin({ manifest, migrations, start, stop })
runtime/src/plugins/index.ts         BUILTIN_PLUGINS: add a static import
src/plugins/<id>/index.tsx           defineUiPlugin({ views, rightSidebarTabs, taskSources, settingsPanel })
src/plugins/index.ts                 UI_PLUGINS: add a lazy import
```

Manifests are plain objects (the example keeps its manifest inline in `index.ts`; a `plugin.json` imported into it works the same). `parseManifest` validates every manifest at boot. **An invalid manifest only disables that plugin**: it is logged and shown as `invalid` in Settings > Plugins, and everything else keeps running.

## 2. Manifest reference (`apiVersion` 1)

| Field | Rules |
|---|---|
| `id` | `2-32` chars: lowercase letters, digits, single hyphens, starts with a letter. Permanent: used in routes, the DB schema and view ids. |
| `name`, `description`, `version` | Display text; `version` is semver. |
| `apiVersion` | Must be `1`. The host refuses other majors. |
| `tier` | Must be `"core"`. |
| `scope` | `"user"`: each user switches it on and configures it. `"install"`: one admin-wide configuration (for example WAHA). |
| `icon` | A Tabler icon name registered in `src/plugins/icons.ts` (add one there if needed; unknown names fall back to a plug). |
| `secrets[]` | `{ name, description?, required? }`. `name` must match the vault format `^[A-Z][A-Z0-9_]{0,63}$`. A plugin can only read secrets it declares. |
| `network.allow[]` | Hosts `ctx.fetch` may reach: exact (`api.example.com`) or `*.suffix` with at least two labels after `*.`. No IP addresses. HTTPS only. |
| `settings[]` | `{ key, type, label, description?, required?, options? }`. Types: `text`, `url`, `number`, `boolean`, `select` (needs `options`), `secretRef`. Rendered by the host in Settings > Plugins and validated on save. |
| `contributes.views[]` | `{ id, label, icon? }`. Appear in the main navigation below Terminal, after a separator. |
| `contributes.taskSources[]` | `{ id, label, view: "generic" \| "custom" }`. Shown as a source group in the Tasks board picker. |
| `contributes.rightSidebarTabs[]` | `{ id, label, icon? }`. Appended after the four core tabs. |
| `contributes.routes` | `true` lets the plugin register `/v1/plugins/<id>/api/*` routes. |
| `contributes.internalRoutes` | `true` lets agents call the plugin (`floq plugin call`). |
| `contributes.webhooks[]` | Hook names exposed unauthenticated at `/v1/plugins/<id>/hooks/<name>/<installToken>`. |
| `contributes.mcpServers[]` | `{ name, type, command/args/env \| url/headers, envSecrets, headerSecrets }`. Installed per user as `plugin-<id>-<name>`; secrets are `floq-vault` references only. |
| `contributes.skills[]` | Folder names under `<plugin dir>/skills/<name>/` (a `SKILL.md` plus text files). They are listed read-only in the bundled scope with a `plugin:<id>` origin, and **copied into the agent home** (global scope, Claude and Codex) of each user the plugin is on for, so agents can load them. Disabling removes the copies. `runtime/scripts/copy-plugin-assets.mjs` (part of `npm run build`) copies the folders next to the compiled plugin. |
| `contributes.migrations` | `true` if the plugin owns a database schema. |
| `contributes.settingsPanel` | `true` if the UI half supplies a custom panel below the generic form. |
| `contributes.canvasNodes` | Reserved. Rejected in v1. |

Unknown keys, undeclared secret references, bad ids, duplicate ids, `tier: "external"` and `apiVersion` other than 1 are rejected. Error messages name the field, never the value.

## 3. Lifecycle

`available` → `enabled` ⇄ `disabled`; three failed starts (with 1 s and 5 s back-off) mark a plugin `failed`. At boot a failure keeps the plugin enabled so the next boot retries it. Enabling and disabling a plugin never overlap (they are serialized per plugin). `stop()` is called on disable and on runtime shutdown. There is no uninstall: plugins ship with the build.

Migrations are an ordered array `{ id, sql }` applied in one transaction together with their ledger rows. Applied ids never change; only append. Each plugin gets the schema `plugin_<id with - → _>`; in SQL, `{{p}}` expands to `""` in schema mode and to the table prefix `plugin_<id>__` in fallback mode, so write `CREATE TABLE {{p}}tickets (...)`. Every table needs a `user_id` column.

## 4. PluginContext (runtime)

| Member | What it does |
|---|---|
| `routes.get/post/put/delete(pattern, handler)` | `/v1/plugins/<id>/api/<pattern>`. Runs as the calling user. `handler({ userId, params, query, body })`; the return value is the JSON body. Throw `HttpError` for other statuses. Decoded params never contain `/`, `\`, NUL or dot segments. |
| `internalRoutes.call(pattern, handler)` | Agent-callable (`floq plugin call <id> <path> [--json BODY]`). Always POST on the wire; the handler also receives `sessionId`. Output is sanitized before the agent sees it. |
| `webhooks.on(name, handler, { verify? })` | Unauthenticated hook. The host checks the install token (constant time), caps the body at 256 KiB, rate-limits, then runs `verify` (for example an HMAC) and the handler. There is no calling user; use `secrets.getInstall`. |
| `secrets.get(userId, name)` | The user's own secret, declared names only. Audited as session `plugin:<id>`. |
| `secrets.getInstall(name)` | `scope:"install"` only: the secret of the admin who enabled the plugin. |
| `settings.get(userId)` | The validated settings values (install config for `scope:"install"`). |
| `fetch(url, init)` | HTTPS only, allow-listed hosts, no redirects, 15 s timeout, 5 MiB cap. Returns `{ status, ok, headers, bytes, text(), json() }`. |
| `db.query(sql, params)` / `db.forUser(userId)` | Runs in a transaction scoped to the plugin schema. `forUser` makes `$1` the user id. |
| `kv.get/set(userId, key)` | Small JSON state per plugin and user (cursors, sync markers). |
| `taskSources.register({ id, provider })` | `provider.list(userId, { query, cursor })` and `provider.get(userId, externalId)`. Items are normalized to `ExternalTask`: `{ sourceId, externalId, title, status, statusCategory: "todo"\|"doing"\|"done", assignee?, priority?, url, updatedAt, fields[] }`. Listings are cached 60 s per user. |
| `events.publish(userId, name, data)` | Frame to that user's open apps only. JSON, at most 64 KiB (throws otherwise). The UI listens with `usePluginEvent`. |
| `approvals.request({ userId, action, detail })` | Asks the user and resolves `"approved"` (single use) / `"denied"` / `"expired"`. Shown as "Plugin: <name>". It waits at most 10 minutes, then withdraws the request and resolves `"expired"`; it is also withdrawn when the plugin stops. The request is stored (audit trail, survives a restart). **Do not await it inline in a `routes` handler**: the client gives up after 90 s. Use it from `internalRoutes` (the agent CLI waits) or return `202` and act from the resolved promise. |
| `log.debug/info/warn/error` | Tagged with the plugin id; revealed secret values are redacted (raw, URL-encoded and JSON-escaped). |
| `schedule(intervalMs, fn)` | Runs never overlap; the minimum interval is 1 s; cleared on stop. |

Anything a handler returns, and any `HttpError` message it throws, is scrubbed of the secrets the plugin revealed. Other errors become a generic `500 plugin_error` and are logged scrubbed.

## 5. Contribution points (UI)

`defineUiPlugin({ views, rightSidebarTabs, taskSources, settingsPanel })`: component maps keyed by the ids declared in the manifest. A component without a manifest declaration, or a declaration without a component, is ignored. A plugin contributes only while the server reports it `enabled` for the signed-in user; a component that throws renders a contained error state (`PluginBoundary`) and the rest of Floq keeps working. Task sources with `view: "generic"` are rendered by the host (`ExternalTaskList`: search, status filter, rows, detail sheet, "Open in <source>"); `"custom"` sources supply their own component. External items never mix into native board search.

## 6. The UI kit and design rules

Plugin UI imports **only** from `react`, `@tabler/icons-react`, `@/plugins/kit`, `@/plugins/sdk` and its own folder (`scripts/test-plugin-imports.mjs` enforces it; plugins cannot ship CSS files).

- `@/plugins/kit` re-exports the shared primitives (Button, Badge, Card, Table, Empty, Field, Input, Textarea, Select, Switch, Checkbox, Tabs, Tooltip, Dialog, AlertDialog, Sheet, DropdownMenu, Skeleton, Kbd, `toast`) plus `PluginPage`, `PluginState`, `ExternalTaskRow`, `PluginBoundary`, `usePlugins`, `usePluginApi`, `usePluginEvent`.
- Use `PluginPage` for the view shell and `PluginState` for `loading | empty | error | not-configured | disabled`. Error states keep what the user typed and offer Retry.
- Use semantic tokens only (`bg-card`, `text-muted-foreground`, `border-border`, …; the list is `src/plugins/tokens.ts`). No hex or `rgb()` colors, no palette utilities like `bg-red-500`, no `backdrop-filter`, no keyframes or ambient motion. Theme, material, reduced motion and forced colors come from the host.
- Icons are Tabler only, by name in the manifest. Plugin views follow the same density as core pages: 13-14 px rows, 28-32 px headings.
- Credentials are vault secrets referenced by name. Never ask for a token in a plugin settings field.

## 7. Security checklist

- [ ] Every secret is declared in `secrets[]`; values are read only through `ctx.secrets`.
- [ ] Never put a token in a URL, error message or log field you build yourself. The host scrubs known values, but prefer headers.
- [ ] `network.allow` lists exact hosts; no `*.com`, no IPs.
- [ ] Anything an agent triggers that writes outward (sends a message, edits a ticket) goes through `ctx.approvals.request`. A click in the UI is consent already.
- [ ] Table names and SQL use `{{p}}`; every table has `user_id`; queries filter by it.
- [ ] Route params are untrusted: validate before putting them in upstream URLs.
- [ ] Webhook handlers verify a signature when the sender supports one and never echo input in errors.
- [ ] Large or slow work uses `ctx.schedule` or `async` I/O, never synchronous loops (plugins run in the runtime process).
- [ ] Remember the trust model: Tier 1 code is fully trusted and `search_path` scoping is a guard rail, not a sandbox. Code review (CODEOWNERS on `runtime/src/plugins/` and `src/plugins/`) is the gate.

## 8. Testing recipe

Runtime (see `runtime/test/pluginHost.test.mts`, `pluginContext.test.mts`, `pluginsServer.test.mts`):

1. Build with `cd runtime && npx tsc -p tsconfig.json` (the plain `npm run build` also runs `prisma generate`, which needs `DATABASE_URL`).
2. Use `fakePool()` from `runtime/test/fixtures/plugins/pgPool.mts` (PGlite behind a `pg.Pool`-shaped object) and construct a `PluginHost` with your definition, a stub vault and a `sink` to capture logs.
3. Call `host.enable(id, "admin")`, then drive routes with `host.handle({...})` or through `createRuntimeServer` like `pluginsServer.test.mts`. Mock `fetchImpl` for upstream calls and assert the token never appears in errors or logs.
4. Run: `node --import ./node_modules/.ptystub/register.mjs --import tsx --test test/<file>.test.mts`.

Frontend: `npx tsc --noEmit`, then `node --test scripts/test-plugin-host.mjs scripts/test-plugin-kit.mjs scripts/test-plugin-imports.mjs scripts/test-plugin-tokens.mjs`.
