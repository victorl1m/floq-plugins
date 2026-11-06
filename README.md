# floq-plugins (catalog)

`index.json` is the catalog Floq reads (default URL `https://raw.githubusercontent.com/victorl1m/floq-plugins/main/index.json`, override with `FLOQ_PLUGIN_CATALOG`).
It lists the plugins; each one is built and released from its own repo:

| Plugin | Repo |
|---|---|
| Movidesk | `victorl1m/floq-plugin-movidesk` |
| Azure DevOps | `victorl1m/floq-plugin-azure-devops` |
| WAHA (WhatsApp) | `victorl1m/floq-plugin-waha` |

Adding or updating a plugin: release it in its repo (tag `v<version>`), then paste the `catalog-entry.json` from that repo's build into `index.json`.
`npm test` checks the catalog with Floq's own parser (`vendor/floq/`, refresh with each plugin repo's `scripts/sync-vendor.sh`).

Installed plugins run inside the Floq runtime with its full privileges; the sha256 only proves the package is the one listed here.
Status: mocked-network tested only.
