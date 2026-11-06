# floq-plugins

Core plugins for [Floq](https://floq.flowless.app): **Movidesk** (tickets), **Azure DevOps** (work items), **WAHA** (WhatsApp inbox), plus a dev **example**.

Each plugin has `runtime/` (backend, `plugin.json` manifest), `ui/` (screens built only from the Floq plugin kit) and `tests/`.

## Requirements
A Floq checkout that includes the plugin system (`runtime/src/plugins/`, `src/plugins/`, plugin kit).

## Install
```
./install.sh /path/to/Floq movidesk azure-devops waha
```
Then register the ids in `runtime/src/plugins/index.ts` and `src/plugins/index.ts`, rebuild, and enable them in Settings > Plugins. Add tokens in Secrets (`MOVIDESK_TOKEN`, `AZURE_DEVOPS_PAT`, WAHA secrets).

## Status
Tested with mocked network calls only. Movidesk/Azure DevOps API shapes and the WAHA webhook HMAC encoding are not yet verified against real services. See `docs/README.md` for the plugin authoring guide.
