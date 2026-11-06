# floq-plugins

Core plugins for [Floq](https://floq.flowless.app): **Movidesk** (tickets), **Azure DevOps** (work items), **WAHA** (WhatsApp inbox), plus a dev **example**.

Each plugin has `runtime/` (backend, `plugin.json` manifest), `ui/` (screens built only from the Floq plugin kit) and `tests/`.

## Install in Floq (admins)
Settings > Plugins > **Browse plugins**. Floq's catalog URL defaults to
`https://raw.githubusercontent.com/victorl1m/floq-plugins/main/index.json` (override with `FLOQ_PLUGIN_CATALOG` on the runtime).
Installed plugins run with the runtime's full privileges: read the trust warning in the install dialog.

## Layout
`plugins/<id>/{plugin.json, runtime/index.ts, ui/index.tsx, skills/, tests/}`. Runtime code gets everything from `ctx` (including `ctx.httpError`),
UI code imports only `react`, `@/plugins/kit` and `@/plugins/sdk` (icons through `resolvePluginIcon`). `ui/` is built only when the manifest contributes views.
`shared/` and `vendor/floq/` hold the SDK types and Floq's parsers (refresh with `scripts/sync-vendor.sh /path/to/Floq`).

## Build, test, release
```
npm install
npm run build     # dist/<id>-<version>.floqpkg.json + dist/index.json, and rewrites ./index.json
npm test          # builds, validates every package and the catalog with Floq's own parser, runs the built plugins against a mocked fetch
npm run check     # fails if ./index.json is not what the build produces
```
Release: bump `version` in `plugin.json`, `npm run build`, commit `index.json`, tag `<id>-v<version>` and push the tag. `.github/workflows/release.yml` rebuilds,
re-checks `index.json` against the bytes and attaches the package to the release. The build is reproducible: the same sources and esbuild version give the same sha256.

The per-plugin `plugins/<id>/tests/` files are the original Floq-harness tests (`PluginHost`, PGlite); they import Floq's `dist/` and run inside a Floq checkout, not here.

## Status
Tested with mocked network calls only. Movidesk/Azure DevOps API shapes and the WAHA webhook HMAC encoding are not yet verified against real services. See `docs/README.md` for the plugin authoring guide.
