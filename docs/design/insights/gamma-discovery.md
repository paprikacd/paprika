# Gamma component discovery

Insights uses maintained Gamma components as its UI source. Discover their behavior and source before adapting them; the catalogue's external reference links are design guidance, not permission to copy another library's implementation.

## Local setup

The local source checkout is `/Users/benebsworth/projects/gamma` at commit `1860ed792a6ce0dbcbb9c6469ace28085c0df035`. Its `plugins/gamma/skills/explore-gamma` skill was copied without overwriting an existing skill to `/Users/benebsworth/.codex/skills/explore-gamma`. A local copy was appropriate because this source is already available locally; the GitHub-oriented skill installer was unnecessary. Source and installed `SKILL.md` have the same SHA-256: `9ac6a7dea02f7ca5d33f3a7eb8c299501cd25596cc976f5d6357580540724e5a`.

Gamma was added through the supported Codex command, preserving the other five configured MCP servers:

```sh
rtk proxy codex mcp add gamma --url http://127.0.0.1:3000/api/mcp
```

The server is running locally. To start it again, from the Gamma checkout:

```sh
rtk proxy npm ci
rtk proxy npm run dev -- --port 3000
```

The MCP endpoint is `http://127.0.0.1:3000/api/mcp`; the visual catalogue is `http://127.0.0.1:3000/catalog`. Discovery verified MCP server `gamma` version `0.3.0`, protocol `2025-11-25`, and 22 advertised tools. Adding a server does not necessarily hotload tools into an existing Codex turn; the script below provides immediate access, while a new/reconnected session can use native tools.

## Repeatable retrieval

From the Paprika checkout, use the dependency-free JSON-RPC client:

```sh
rtk proxy node scripts/gamma-discovery.mjs --verify
rtk proxy node scripts/gamma-discovery.mjs --search breadcrumb
rtk proxy node scripts/gamma-discovery.mjs --brief breadcrumb-trail --output /tmp/gamma-brief.json
rtk proxy node scripts/gamma-discovery.mjs --component breadcrumb-trail --output /tmp/gamma-component.json
rtk proxy node scripts/gamma-discovery.mjs --system gamma --output /tmp/gamma-tokens.json
rtk proxy node scripts/gamma-discovery.mjs --manifest
```

`--endpoint` / `GAMMA_MCP_URL` and `--repo` / `GAMMA_SOURCE_DIR` override defaults. `--metadata` omits source and CSS from a component response. Use an output file for full bundles to avoid flooding terminal output. The script initializes the MCP session, checks required tools, bounds requests to 30 seconds, and reports provider errors instead of substituting source.

The native workflow is `gamma_search_catalogue` → `gamma_get_component_brief` → `gamma_get_component` with `includeSource: true`, plus `gamma_get_design_system` for tokens. `gamma_get_catalogue_entry` provides additional provenance when needed. Names are exact: `breadcrumb-trail`, `search-combobox`, `side-sheet`, `action-menu`, `floating-field`, `data-table`; there is no `sidebar` component.

## Source and style rules

- Read the component brief before selecting a component. Keep its labels, keyboard behavior, focus management, native semantics and reduced-motion behavior when adapting controlled props for Paprika.
- Component responses contain `catalog`, `source`, `css`, `example` and `references`. Some named CSS sections are scoped; other components, including `button`, currently return the entire shared stylesheet (about 473 KiB). Extract the component's rules and dependencies, using Gamma tokens, instead of importing that whole file.
- `data-table` is Apache-2.0. Its returned source includes the required license and notice. Preserve them if adapting it. Shared table engines may be flattened into standalone component bundles, so returned source can legitimately differ from the checkout's single source file.
- [gamma-source-catalogue.json](gamma-source-catalogue.json) records 18 relevant components, selection notes, source paths, source/bundle hashes, CSS hashes and external references. It contains no component source or credentials. Regenerate it after updating the Gamma checkout; review changes rather than silently replacing vendored UI.

Validation performed: initialization, tool enumeration, catalogue search, maintained Button and Breadcrumb source retrieval, component briefs, the Gamma design-system stylesheet, and complete retrieval of all 18 manifest entries. Installed skill contents match the local source. The Gamma checkout's skill, MCP configuration, package files and public source were unchanged by setup.
