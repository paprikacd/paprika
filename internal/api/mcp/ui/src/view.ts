import { array, collection, escape as e, field, identity, label, number, object, resourceRows, string, tone, type Json, type State } from "./model.ts";
import { setupCommands, switchPrompt } from "./connections.ts";
import { paprikaMark } from "./brand.ts";

const badge = (value: unknown, fallback = "Unknown") => `<span class="badge ${tone(value)}"><span class="status-dot" aria-hidden="true"></span>${e(label(value, fallback))}</span>`;
const error = (message?: string) => message ? `<div class="error" role="alert">${e(message)}</div>` : "";
const empty = (message: string) => `<p class="empty">${e(message)}</p>`;
const time = (value: unknown, seconds = false) => {
  const date = typeof value === "string" && !/^\d+$/.test(value) ? new Date(value) : new Date(number(value) * (seconds ? 1000 : 1));
  return date.getTime() > 0 && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "No timestamp";
};
const sectionNote = (section: Json) => {
  const status = string(section.status);
  const issue = ["error", "forbidden", "stale", "not_available", "not_configured", "partial"].includes(status);
  return `${issue ? `<p class="evidence-note ${status === "error" || status === "forbidden" ? "danger-text" : ""}">${e(label(status))}${section.error ? `: ${e(section.error)}` : ""}</p>` : ""}${section.note ? `<p class="subtle">${e(section.note)}</p>` : ""}${section.truncated ? `<p class="evidence-note">Showing ${collection(section).length} of ${e(section.totalCount ?? "the available")} records.</p>` : ""}`;
};
const conditions = (value: unknown) => collection(value).map((condition) => `<div class="condition">
  <div class="condition-title"><strong>${e(condition.type)}</strong><span class="subtle">${e(condition.status ?? "Unknown")}</span></div>
  <p>${e(condition.message || condition.reason || "No message recorded.")}</p>
  <span class="subtle">${e(condition.reason)}${field(condition, "lastTransitionTime") ? ` · ${e(time(field(condition, "lastTransitionTime")))}` : ""}</span>
</div>`).join("");

const driftResource = (item: Json) => `<div class="drift-resource"><div class="section-heading"><strong>${e(item.kind)}/${e(item.name)}</strong>${badge(item.sync)}</div>
  <p class="subtle">${e(item.group || "core")}${item.version ? `/${e(item.version)}` : ""} · ${e(item.summary || item.message || label(item.reason || item.category))}</p>
  ${array(item.fields).length ? `<details><summary>Changed fields (${e(field(item, "changedFieldCount") ?? array(item.fields).length)})</summary><div class="field-diff" role="table" aria-label="Desired and live values"><div role="row" class="field-diff-heading"><span role="columnheader">Field</span><span role="columnheader">Desired</span><span role="columnheader">Live</span></div>${array(item.fields).map((change) => `<div role="row"><code role="cell">${e(change.path)}</code><pre role="cell">${e(string(change.desired, "Not reported").slice(0, 2000))}</pre><pre role="cell">${e(string(change.live, "Not reported").slice(0, 2000))}</pre></div>`).join("")}</div>${field(item, "fieldsTruncated") ? `<p class="evidence-note">Only the first changed fields are included in this summary.</p>` : ""}</details>` : ""}</div>`;

function fleetRail(state: State): string {
  return `<aside class="fleet-rail" aria-label="Applications">
    <div class="rail-heading"><h2>Applications <span class="count">${e(state.total)}</span></h2></div>
    <form id="fleet-search" class="filters" aria-label="Find applications">
      <label for="search">Search applications</label><div class="search-field"><span aria-hidden="true">⌕</span><input id="search" name="search" type="search" placeholder="Name, project, resource…" value="${e(state.search)}"></div>
      <div class="namespace-field"><label for="namespace">Namespace</label><input id="namespace" name="namespace" placeholder="All namespaces" value="${e(state.namespace)}"><button class="small" type="submit" ${state.busy.has("fleet") ? "disabled" : ""}>Apply</button></div>
    </form>
    ${error(state.errors.fleet)}
    <div class="app-list" aria-busy="${state.busy.has("fleet")}">${state.applications.map((app) => {
      const id = identity(app);
      const selected = state.selected?.name === id.name && state.selected.namespace === id.namespace;
      const attention = string(field(app, "attentionLabel"));
      return `<button class="app-row ${selected ? "selected" : ""}" data-app="${e(id.name)}" data-namespace="${e(id.namespace)}" aria-pressed="${selected}">
        <div class="app-row-title"><span class="status-dot ${tone(app.health)}" aria-hidden="true"></span><strong>${e(id.name)}</strong><span class="drift-count">${number(field(app, "driftCount")) > 0 ? `${e(field(app, "driftCount"))} drift` : ""}</span></div>
        <div class="app-row-meta"><span>${e(id.namespace)}</span><span>${e(label(app.health))}</span></div>
        ${attention ? `<p class="app-attention">${e(attention)}</p>` : ""}
      </button>`;
    }).join("") || empty(state.busy.has("fleet") ? "Loading applications…" : "No applications match these filters.")}</div>
    ${state.cursor ? `<div class="rail-footer"><button class="wide small" data-action="more" ${state.busy.has("fleet") ? "disabled" : ""}>${state.busy.has("fleet") ? "Loading…" : "Load more applications"}</button></div>` : ""}
  </aside>`;
}

function fleetSummary(state: State): string {
  const total = number(state.fleet.total);
  const attention = number(field(state.fleet, "attentionTotal"));
  const healthy = array(state.fleet.health).filter((bucket) => tone(bucket.health) === "success").reduce((count, bucket) => count + number(bucket.count), 0);
  const unknown = array(state.fleet.health).filter((bucket) => tone(bucket.health) === "neutral").reduce((count, bucket) => count + number(bucket.count), 0);
  return `<div class="fleet-summary" aria-label="Fleet health snapshot"><div><strong>${e(total)}</strong><span>applications</span></div><div class="success-text"><strong>${e(healthy)}</strong><span>healthy</span></div><div class="${attention ? "danger-text" : ""}"><strong>${e(attention)}</strong><span>need attention</span></div>${unknown ? `<div><strong>${e(unknown)}</strong><span>unknown</span></div>` : ""}<p class="snapshot">${state.observedAt ? `Snapshot ${e(time(state.observedAt))}` : "Waiting for fleet snapshot"}</p></div>`;
}

function healthView(state: State): string {
  const health = state.health!;
  const status = object(health.status);
  const checks = collection(health.healthChecks);
  const activeConditions = collection(health.conditions).filter((item) => item.status !== "False");
  const gates = collection(health.gates);
  const analysis = collection(health.analysis);
  const drift = object(health.drift);
  const driftData = object(drift.data);
  const driftRows = collection(driftData.resources);
  const failingResources = resourceRows(health).filter((item) => tone(item.health) === "danger" || (item.syncStatus && !["Synced", "SYNCED"].includes(string(item.syncStatus))));
  return `<div class="health-overview"><div class="health-primary">${badge(status.health)}<span class="subtle">Reported by the application controller</span></div>
    <dl class="status-grid"><div><dt>Delivery phase</dt><dd>${e(status.phase || "Unknown")}</dd></div><div><dt>Sync state</dt><dd>${status.synced === true ? "Synced" : status.synced === false ? "Not synced" : "Unknown"}</dd></div><div><dt>Out of sync</dt><dd class="${number(status.outOfSync) ? "danger-text" : ""}">${status.outOfSync === undefined ? "Unknown" : e(status.outOfSync)}</dd></div><div><dt>Current stage</dt><dd>${e(status.currentStage || "Not reported")}</dd></div></dl>
    ${status.retriesExhausted === true ? `<div class="callout danger-callout"><strong>Release retries exhausted</strong><p>This application is waiting for a new release or an explicit retry. Inspect the conditions and release evidence before syncing.</p></div>` : ""}
    ${status.partial ? `<div class="callout"><strong>Some evidence is unavailable</strong><p>Inspect the section notes below. Missing evidence does not establish application health.</p></div>` : ""}
    <p class="subtle observation">Read ${e(time(health.observedAt))}. Controller status may lag; check the recorded evidence timestamps.</p>
  </div>
  <section class="evidence-section"><div class="section-heading"><h3>Conditions</h3><span class="subtle">${activeConditions.length} active or unknown</span></div>${conditions(activeConditions) || empty("No active conditions are recorded.")}${sectionNote(object(health.conditions))}</section>
  <section class="evidence-section"><div class="section-heading"><h3>Health checks</h3><span class="subtle">${checks.length} recorded</span></div>${checks.map((check) => `<div class="check-row"><div><strong>${e(check.name || "Unnamed check")}</strong><p>${e(check.message || check.reason || "No check message recorded.")}</p><span class="subtle">${e(time(field(check, "checkedAt"), true))}${field(check, "durationMillis") ? ` · ${e(field(check, "durationMillis"))} ms` : ""}</span></div>${badge(check.status)}</div>`).join("") || empty("No health check results are recorded. Resource health is shown separately.")}${sectionNote(object(health.healthChecks))}</section>
  <section class="evidence-section"><div class="section-heading"><h3>Resource issues</h3><button class="text-button" data-tab="resources">View resources</button></div>${failingResources.map((item) => `<div class="issue-row"><strong>${e(item.kind)}/${e(item.name)}</strong>${badge(item.health || item.syncStatus)}<p>${e(item.message || item.syncStatus || "Inspect the resource for current evidence.")}</p></div>`).join("") || empty("No failing resources appear in the recorded controller evidence.")}${sectionNote(object(health.resources))}${sectionNote(object(object(health.resources).health))}${sectionNote(object(object(health.resources).sync))}</section>
  <section class="evidence-section"><div class="section-heading"><h3>Drift evidence</h3>${badge(drift.status, "Unavailable")}</div>${sectionNote(drift)}${field(driftData, "evaluatedAtUnixMs") ? `<p class="subtle">Evaluated ${e(time(field(driftData, "evaluatedAtUnixMs")))}</p>` : ""}${driftRows.map(driftResource).join("")}${drift.status === "complete" && !driftRows.length ? empty("No drift records were returned for this observation.") : ""}${sectionNote(object(driftData.resources))}</section>
  ${gates.length ? `<section class="evidence-section"><h3>Approval gates</h3>${gates.map((gate) => `<div class="check-row"><div><strong>${e(gate.name || gate.stage || "Gate")}</strong><p>${e(gate.message || gate.reason)}</p></div>${badge(gate.status)}</div>`).join("")}${sectionNote(object(health.gates))}</section>` : ""}
  ${analysis.length ? `<section class="evidence-section"><h3>Canary analysis</h3>${analysis.map((check) => `<div class="check-row"><div><strong>${e(check.name || "Analysis check")}</strong><p>${e(check.message)}</p><span class="subtle">${e(time(field(check, "checkedAt")))}</span></div>${badge(check.passed === true ? "Passed" : check.passed === false ? "Failed" : check.phase)}</div>`).join("")}${sectionNote(object(health.analysis))}</section>` : ""}
  <dl class="source-details"><div><dt>Current release</dt><dd>${e(status.releaseRef || "Not reported")}</dd></div><div><dt>Source revision</dt><dd>${e(status.sourceRevision || status.revision || "Not reported")}</dd></div></dl>`;
}

function resourcesView(state: State): string {
  const rows = resourceRows(state.health ?? {}, state.tree);
  return `<section class="evidence-section"><div class="section-heading"><div><h3>Managed resources</h3><p class="subtle">${state.tree ? "Detailed live resource tree" : "Recorded health and sync reports"}</p></div><button class="small" data-action="resources" ${state.busy.has("resources") ? "disabled" : ""}>${state.busy.has("resources") ? "Loading…" : "Refresh resources"}</button></div>
    ${error(state.errors.resources)}${!state.tree ? `<p class="subtle">Health and sync reports remain separate because their records do not include API groups.</p>` : ""}
    <div class="resource-list">${rows.map((row, index) => `<div class="resource-row"><div class="resource-heading"><div><span class="resource-kind">${e(row.kind)}</span><strong>${e(row.name)}</strong><span class="subtle">${e(row.namespace || "Cluster scoped")}${row.evidence ? ` · ${e(row.evidence)}` : ""}</span></div><div class="resource-status">${badge(row.health)}${row.syncStatus || field(row, "syncStatus") ? `<span class="subtle">${e(label(field(row, "syncStatus")))}</span>` : ""}</div></div>
      <p>${e(field(row, "healthMessage") || row.message || row.phase)}</p><div class="resource-bottom"><span class="subtle">${row.total ? `${e(row.ready ?? 0)}/${e(row.total)} ready` : ""}${row.parentKind ? `Owned by ${e(row.parentKind)}/${e(row.parentName)}` : ""}</span>${["Deployment", "StatefulSet", "DaemonSet", "Pod", "Job"].includes(string(row.kind)) ? `<button class="small" data-log="${index}" ${state.busy.has("logs") ? "disabled" : ""}>View logs</button>` : ""}</div></div>`).join("") || empty(state.busy.has("resources") ? "Loading the resource tree…" : "No resource evidence was returned.")}</div>
  </section>`;
}

function releasesView(state: State): string {
  const releases = object(state.health?.releases);
  const rollouts = object(state.health?.rollouts);
  return `<section class="evidence-section"><div class="section-heading"><h3>Recent releases</h3><span class="subtle">${e(releases.totalCount ?? collection(releases).length)} recorded</span></div>${sectionNote(releases)}
    <div class="release-list">${collection(releases).map((release) => `<article class="release-row"><div class="section-heading"><strong>${e(release.name)}</strong>${badge(release.phase)}</div><p class="subtle">${e(time(field(release, "createdAt"), true))} · ${e(field(release, "currentStage") || release.target || "No stage reported")}</p>${number(field(release, "canaryWeight")) > 0 ? `<p>Canary traffic <strong>${e(field(release, "canaryWeight"))}%</strong> · step ${e(field(release, "canaryStepIndex"))}</p>` : ""}${field(release, "rolledBackTo") ? `<p>Rolled back to ${e(field(release, "rolledBackTo"))}</p>` : ""}${conditions(collection(release.conditions).filter((condition) => tone(release.phase) === "danger" || condition.status !== "False"))}${collection(release.hooks).filter((hook) => tone(hook.phase || hook.status) !== "success").map((hook) => `<p>${e(hook.kind)}/${e(hook.name)}: ${e(hook.message || hook.phase || hook.status)}</p>`).join("")}</article>`).join("") || empty("No recent releases are available in this observation.")}</div>
  </section><section class="evidence-section"><h3>Linked rollouts</h3>${sectionNote(rollouts)}${array(rollouts.errors).map((issue) => `<p class="evidence-note danger-text">${e(issue.namespace)}/${e(issue.name)}: ${e(issue.error)}</p>`).join("")}${collection(rollouts).map((rollout) => `<article class="release-row"><div class="section-heading"><strong>${e(rollout.name)}</strong>${badge(rollout.phase)}</div><p>${e(rollout.message || rollout.strategyType)}</p><p class="subtle">${number(rollout.currentWeight)}% canary · step ${number(rollout.currentStep)}${rollout.paused ? " · paused" : ""}</p>${conditions(collection(rollout.conditions).filter((condition) => condition.status !== "False"))}</article>`).join("") || empty("No linked rollout evidence is available for these releases.")}</section>`;
}

function debugView(state: State, supportsMessage: boolean): string {
  const investigation = state.investigation;
  const findings = array(investigation?.findings);
  return `<section class="evidence-section"><div class="section-heading"><div><h3>Investigation</h3><p class="subtle">Read current failure signals and supporting evidence.</p></div><button class="primary small" data-action="investigate" ${state.busy.has("investigation") ? "disabled" : ""}>${state.busy.has("investigation") ? "Investigating…" : investigation ? "Run again" : "Run investigation"}</button></div>
    ${error(state.errors.investigation)}${investigation ? `<p class="investigation-summary">${e(investigation.summary || "No investigation summary returned.")}</p>${findings.map((finding) => `<article class="finding"><div class="section-heading"><h4>${e(finding.title)}</h4>${badge(finding.severity)}</div><p>${e(finding.description)}</p>${array(finding.evidence).length ? `<details><summary>Supporting evidence (${array(finding.evidence).length})</summary>${array(finding.evidence).map((item) => `<div class="condition"><strong>${e(item.source)}</strong><p>${e(item.summary)}</p><span class="subtle">${e(item.timestamp)}</span></div>`).join("")}</details>` : ""}${Array.isArray(finding.playbook) && finding.playbook.length ? `<details><summary>Suggested next steps</summary><ul>${finding.playbook.map((step) => `<li>${e(step)}</li>`).join("")}</ul></details>` : ""}</article>`).join("") || empty("No findings were returned. Check other evidence before concluding the application is healthy.")}` : empty("Run an investigation when you need an explanation of the application's current state.")}
    ${supportsMessage ? `<button class="small" data-action="debug" ${state.busy.has("message") || state.busy.has("switch") || state.switchTarget ? "disabled" : ""}>Ask the conversation to debug</button>` : `<p class="subtle">To continue with an agent, ask the conversation to investigate ${e(state.selected?.namespace)}/${e(state.selected?.name)} on ${e(state.connection?.endpoint ?? "the originating connection, after verifying its endpoint")}.</p>`}
  </section>
  <section class="evidence-section"><div class="section-heading"><h3>Workload logs</h3>${state.logResource ? `<span class="subtle">${e(state.logResource.kind)}/${e(state.logResource.name)}</span>` : ""}</div>${error(state.errors.logs)}
    ${state.busy.has("logs") ? `<p role="status">Reading the latest 200 lines…</p>` : state.logs ? `<p class="subtle">${e(field(state.logs, "podName"))}${field(state.logs, "containerName") ? ` · ${e(field(state.logs, "containerName"))}` : ""} · latest 200 lines requested</p><pre class="logs" tabindex="0" aria-label="Workload logs">${e(state.logs.logs || "No log lines returned.")}</pre>` : empty("Select View logs on a workload in Resources. Logs load only when requested.")}
  </section>`;
}

function instanceHeader(state: State): { picker: string; detail: string } {
  const current = state.connection;
  const saved = state.instances.find((item) => item.endpoint === current?.endpoint);
  const hostname = current ? new URL(current.endpoint).host : "Site unverified";
  const name = saved?.label || hostname;
  const account = current?.account.email || current?.account.name;
  const access = current?.scopes.includes("paprika:write") ? "Read + write" : current?.scopes.includes("paprika:read") ? "Read access" : "Access not reported";
  return { picker: `<button id="instance-picker" class="instance-picker" data-action="instances" aria-label="Choose Paprika site. ${e(name)}, ${e(hostname)}" aria-haspopup="dialog" aria-expanded="${state.instanceDialog}" aria-controls="instance-dialog">
    <span class="instance-dot ${current ? "verified" : ""}" aria-hidden="true"></span><span class="instance-heading"><strong>${e(name)}</strong>${name !== hostname ? `<span>${e(hostname)}</span>` : ""}</span><span class="instance-chevron" aria-hidden="true">⌄</span>
  </button>`, detail: `<div class="connection-strip" aria-label="Current site"><span class="connection-state">${current ? "Verified site" : state.busy.has("identity") ? "Verifying site…" : "Unverified site"}</span>${current ? `<span>${e(access)}</span>${account ? `<span title="${e(account)}">${e(account)}</span>` : ""}${current.server.version ? `<span class="build-version" title="${e(current.server.commit || current.server.version)}">${e(current.server.version)}</span>` : ""}` : `<button class="text-button" data-action="verify-instance" ${state.busy.has("identity") ? "disabled" : ""}>Verify connection</button>`}</div>` };
}

function instancesDialog(state: State, supportsMessage: boolean): string {
  if (!state.instanceDialog) return "";
  const setup = state.setupInstance;
  const current = state.connection;
  const savedCurrent = state.instances.find((item) => item.endpoint === current?.endpoint);
  const otherSites = state.instances.filter((item) => item.endpoint !== current?.endpoint);
  const account = current?.account.email || current?.account.name;
  const access = current?.scopes.includes("paprika:write") ? "Read + write" : current?.scopes.includes("paprika:read") ? "Read access" : "Access not reported";
  return `<div class="instance-overlay"><div class="instance-backdrop" data-dismiss-instances="true"></div><section id="instance-dialog" class="instance-dialog" role="dialog" aria-modal="true" aria-labelledby="instances-title" aria-describedby="instances-description" tabindex="-1">
    <header class="instance-dialog-heading"><div><h2 id="instances-title">Paprika sites</h2><p id="instances-description">Choose the deployment you want to view.</p></div><button class="icon-button" data-action="close-instances" aria-label="Close sites">×</button></header>
    <div class="instance-dialog-body">
    <section class="site-current" aria-label="Current site"><div class="site-current-heading"><img class="site-current-mark" src="${paprikaMark}" width="36" height="36" alt=""><div><strong>${e(savedCurrent?.label || (current ? new URL(current.endpoint).host : "Current console"))}</strong><p title="${e(current?.endpoint ?? "")}">${e(current ? new URL(current.endpoint).host : "Originating site is unverified")}</p></div><span class="site-current-badge">Viewing</span></div>
      <div class="site-current-detail">${current ? `<span class="instance-dot verified" aria-hidden="true"></span><span>Verified site</span><span>${e(access)}</span>${account ? `<span title="${e(account)}">${e(account)}</span>` : ""}` : `<p>Verify this connection before requesting changes.</p><button class="text-button" data-action="verify-instance" ${state.busy.has("identity") ? "disabled" : ""}>Verify connection</button>`}</div>
      ${savedCurrent ? `<button class="text-button current-setup" data-setup="${e(savedCurrent.connection)}">Connection details</button>` : ""}
    </section>
    ${otherSites.length ? `<section class="site-destinations" aria-labelledby="other-sites-title"><h3 id="other-sites-title">Other sites</h3><div class="instance-list">${otherSites.map((item) => {
      const pending = state.switchTarget?.connection === item.connection;
      return `<article class="instance-row"><div class="site-icon" aria-hidden="true"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.35"><circle cx="10" cy="10" r="7.4"/><path d="M2.6 10h14.8M10 2.6c4.2 4.2 4.2 10.6 0 14.8-4.2-4.2-4.2-10.6 0-14.8Z"/></svg></div><div class="instance-row-content"><strong>${e(item.label)}</strong><p title="${e(item.endpoint)}">${e(new URL(item.endpoint).host)}</p><span class="instance-state">${pending ? "Open requested" : item.example ? "Suggested site · sign-in not checked" : "Saved site · sign-in not checked"}</span></div><div class="instance-row-actions"><button class="small" data-instance="${e(item.connection)}" ${state.busy.has("switch") ? "disabled" : ""}>${pending ? "Requested" : supportsMessage ? "Open site" : "Connect"}</button><button class="text-button" data-setup="${e(item.connection)}" aria-label="Connection setup for ${e(item.label)}">Setup</button>${!item.example ? `<button class="text-button forget-site" data-remove-instance="${e(item.connection)}" aria-label="Forget ${e(item.label)} preference">Forget</button>` : ""}</div></article>`;
    }).join("")}</div></section>` : ""}
    ${state.switchTarget ? `<p class="instance-pending" role="status">Requested ${e(state.switchTarget.label)} in the conversation. This console stays on ${e(state.connection?.endpoint ?? "the originating connection")} until a new console opens.</p>` : ""}${error(state.errors.switch)}
    ${setup ? `<details id="site-setup-details" data-disclosure-key="${e(setup.connection)}" class="site-disclosure instance-setup" open><summary id="site-setup-summary"><span>Connection setup</span><span class="disclosure-meta">${e(setup.label)}</span></summary><div class="disclosure-content"><h3>Connect ${e(setup.label)}</h3><p>Use this site's connection in Codex, then complete its sign-in.</p><dl class="site-connection-details"><div><dt>Endpoint</dt><dd>${e(setup.endpoint)}</dd></div><div><dt>Connection name</dt><dd>${e(setup.connection)}</dd></div></dl><pre class="setup-code" tabindex="0" aria-label="Codex setup commands">${e(setupCommands(setup))}</pre><details id="site-open-prompt" data-disclosure-key="${e(setup.connection)}" class="site-open-prompt"><summary id="site-open-prompt-summary">Open this site after sign-in</summary><p class="setup-prompt">${e(switchPrompt(setup))}</p></details></div></details>` : ""}
    <details id="site-add-details" class="site-disclosure site-add" ${state.errors.instance ? 'open data-force-open="true"' : ""}><summary id="site-add-summary">Add a site</summary><form id="instance-form" class="instance-form"><p class="subtle">Save a deployment to open it here again.</p><div class="instance-form-fields"><label for="instance-label">Site name<input id="instance-label" name="label" placeholder="Team production" maxlength="64" required></label><label for="instance-connection">Connection name<input id="instance-connection" name="connection" placeholder="paprika_team" maxlength="64" pattern="[a-zA-Z][a-zA-Z0-9_-]{0,63}" required></label><label for="instance-endpoint">Site endpoint<input id="instance-endpoint" name="endpoint" type="url" placeholder="https://paprika.example.com/mcp" maxlength="512" required></label></div>${error(state.errors.instance)}<div class="instance-form-footer"><p class="subtle">Sign-in is managed by Codex. Only these site preferences are saved here.</p><button class="small primary" type="submit">Save site</button></div></form></details>
    ${state.storageUnavailable ? `<p class="evidence-note">Browser storage is unavailable. Site preferences work for this console session.</p>` : ""}</div>
    <footer class="instance-dialog-footer"><p>Each site opens with its own connection and sign-in.</p><button class="small" data-action="close-instances">Done</button></footer>
  </section></div>`;
}

export function render(state: State, supportsContext: boolean, supportsMessage: boolean): string {
  const selected = state.selected;
  const instance = instanceHeader(state);
  return `<div class="shell" ${state.instanceDialog ? 'inert aria-hidden="true"' : ""}><header class="topbar"><button class="brand" data-action="overview" aria-label="Fleet overview"><img class="brand-mark" src="${paprikaMark}" width="30" height="30" alt=""><span>Paprika</span><span class="brand-divider"></span><span class="subtle">Fleet</span></button><div class="topbar-controls">${instance.picker}<button class="small refresh-fleet" aria-label="Refresh fleet" data-action="refresh-fleet" ${state.busy.has("fleet") || !state.connected ? "disabled" : ""}>${state.busy.has("fleet") ? "Refreshing…" : "Refresh fleet"}</button></div></header>${instance.detail}
    ${error(state.errors.connection)}${error(state.errors.identity)}${state.switchTarget ? `<div class="switch-banner" role="status"><p>Opening ${e(state.switchTarget.label)} was requested. This view remains on ${e(state.connection?.endpoint ?? "its originating connection")}.</p><div><button class="text-button" data-action="instances">View sites</button><button class="small" data-action="stay-instance">Stay here</button></div></div>` : ""}${fleetSummary(state)}<div class="workspace">${fleetRail(state)}<main class="app-workspace" id="application-detail" aria-label="Application detail">
    ${selected ? `<header class="app-header"><div><p class="breadcrumb">${e(selected.namespace)}</p><h1>${e(selected.name)}</h1></div><div class="app-actions"><button class="small" data-action="refresh-health" ${state.busy.has("health") ? "disabled" : ""}>${state.busy.has("health") ? "Refreshing…" : "Refresh health"}</button>${supportsContext ? `<button class="small" data-action="attach" ${state.busy.has("context") ? "disabled" : ""}>Attach to chat</button>` : ""}</div></header>
      <nav class="tabs" aria-label="Application views">${(["health", "resources", "releases", "debug"] as const).map((tab) => `<button data-tab="${tab}" ${state.tab === tab ? 'class="active" aria-current="page"' : ""}>${tab === "health" ? "Health" : tab === "resources" ? "Resources" : tab === "releases" ? "Deployments" : "Debug"}</button>`).join("")}</nav>
      ${error(state.errors.health)}${error(state.errors.context)}${error(state.errors.message)}${state.notice ? `<p class="notice" role="status">${e(state.notice)}</p>` : ""}
      <div class="app-content" aria-busy="${state.busy.has("health")}">${state.tab === "resources" ? resourcesView(state) : state.tab === "debug" ? debugView(state, supportsMessage) : state.health ? (state.tab === "health" ? healthView(state) : releasesView(state)) : state.busy.has("health") ? `<div class="loading" role="status"><div class="loading-line"></div><p>Reading health, releases and drift evidence…</p></div>` : empty("Health evidence is unavailable. Refresh health to try again, or use Resources and Debug to inspect other evidence.")}</div>
      ${supportsMessage ? `<footer class="app-footer"><span class="subtle">${state.connection ? `Actions target ${e(new URL(state.connection.endpoint).host)}.` : "Verify the instance before requesting changes."}</span><button class="small" data-action="sync" ${state.busy.has("message") || state.busy.has("switch") || !state.connection || state.switchTarget ? "disabled" : ""}>Request sync</button></footer>` : ""}` : `<div class="welcome"><img class="welcome-mark" src="${paprikaMark}" width="88" height="88" alt="Paprika capsicum logo"><h1>Your delivery fleet</h1><p>Select an application to check its health, follow a deployment, or investigate an issue.</p><button class="small welcome-sites" data-action="instances">Choose a site</button>${!state.connected ? `<p class="subtle">Connecting to the host…</p>` : !state.observedAt ? `<p class="subtle">Waiting for the fleet opener's result.</p>` : ""}</div>`}
    </main></div></div>${instancesDialog(state, supportsMessage)}`;
}
