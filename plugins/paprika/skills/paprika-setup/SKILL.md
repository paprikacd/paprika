---
name: paprika-setup
description: Connect or reconnect the Paprika plugin using the client's native OAuth flow, discover its read tools, and verify fleet access. Use only when the user asks to set up Paprika, sign in, or change granted scopes.
---

# Connect Paprika

Use the packaged remote MCP endpoint `https://paprika.benebsworth.com/mcp`.
If Paprika tools are already available, call `fleet_status` once to verify
access. If authentication is required, open the client's native MCP OAuth
connection flow and let the user sign in and grant scopes there. Do not ask for
pasted credentials, bearer tokens, kubeconfigs, or secrets; do not store them
in the package or chat.

Start with `paprika:read` for fleet/application inspection. Add `paprika:write`
only when the user wants delivery actions. Scope grants and Paprika's RBAC are
both required; write access does not imply read access.

For the Codex CLI, the supported commands are:

```sh
codex mcp add paprika_hosted --url https://paprika.benebsworth.com/mcp
codex mcp login paprika_hosted --scopes paprika:read
```

For a user-requested write connection, use the native consent flow with both
scopes (or `codex mcp login paprika_hosted --scopes paprika:read,paprika:write`).
In desktop clients use their MCP/plugin connection UI. If plugin installation
or reloading is needed, follow the host's supported flow; adding a raw MCP
endpoint alone may not load these packaged skills or an interactive view.

After connection, discover tools and call `fleet_status` once. Report the
returned fleet data or the actual error. Offer `open_fleet` when available in
a host supporting MCP Apps. If the deployed server lacks the new tools or the
host lacks Extensions support, retain normal read tools and state what remains
unverified. Editing this source package does not update the remote deployment.
