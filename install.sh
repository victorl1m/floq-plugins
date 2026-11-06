#!/usr/bin/env bash
# Usage: ./install.sh /path/to/Floq [plugin-id ...]   (default: movidesk azure-devops waha)
set -euo pipefail
FLOQ="${1:?path to your Floq checkout}"; shift || true
IDS=("$@"); [ ${#IDS[@]} -eq 0 ] && IDS=(movidesk azure-devops waha)
HERE="$(cd "$(dirname "$0")" && pwd)"
for id in "${IDS[@]}"; do
  [ -d "$HERE/plugins/$id" ] || { echo "unknown plugin $id"; exit 1; }
  mkdir -p "$FLOQ/runtime/src/plugins/$id" "$FLOQ/src/plugins/$id"
  cp -r "$HERE/plugins/$id/runtime/." "$FLOQ/runtime/src/plugins/$id/"
  cp -r "$HERE/plugins/$id/ui/." "$FLOQ/src/plugins/$id/"
  echo "installed $id"
done
echo "Next: register each id in runtime/src/plugins/index.ts (BUILTIN_PLUGINS) and src/plugins/index.ts (UI_PLUGINS), rebuild, enable in Settings > Plugins."
