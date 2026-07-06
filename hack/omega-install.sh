#!/usr/bin/env bash
set -euo pipefail

OMEGA_DIR="$(cd "$(dirname "$0")/../terraform" && pwd)"
OIDC_KUBECONFIG="$OMEGA_DIR/omega-oidc.kubeconfig"
DEFAULT_KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"

if [ ! -f "$OIDC_KUBECONFIG" ]; then
  echo "Error: $OIDC_KUBECONFIG not found. Run 'make omega-apply' first."
  exit 1
fi

# Use python3 to merge the OIDC kubeconfig into the default kubeconfig
python3 << PYEOF
import yaml, os

kubedir = os.path.expanduser("~/.kube")
os.makedirs(kubedir, exist_ok=True)

default_path = os.environ.get("KUBECONFIG", os.path.join(kubedir, "config"))
oidc_path = "$OIDC_KUBECONFIG"

# Load both configs
default = {"apiVersion": "v1", "kind": "Config", "clusters": [], "contexts": [], "users": [], "preferences": {}}
if os.path.exists(default_path):
    with open(default_path) as f:
        default = yaml.safe_load(f) or default

with open(oidc_path) as f:
    oidc = yaml.safe_load(f) or {}

def merge_list(existing, new, key="name"):
    """Merge new items into existing list, replacing items with matching keys."""
    merged = list(existing)
    existing_names = {item[key]: i for i, item in enumerate(existing)}
    for item in new:
        if item[key] in existing_names:
            merged[existing_names[item[key]]] = item
        else:
            merged.append(item)
    return merged

default["clusters"] = merge_list(default.get("clusters", []), oidc.get("clusters", []))
default["contexts"] = merge_list(default.get("contexts", []), oidc.get("contexts", []))
default["users"] = merge_list(default.get("users", []), oidc.get("users", []))
default["current-context"] = oidc.get("current-context", default.get("current-context", ""))

with open(default_path, "w") as f:
    yaml.dump(default, f, default_flow_style=False)

print(f"Installed omega-oidc context into {default_path}")
print(f"Switched to context: {default['current-context']}")
PYEOF
