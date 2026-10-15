package observabilitygateway

import (
	"encoding/json"
	"net/http"
	"strings"
)

// ConsentHandler serves the gateway's minimal, self-contained browser
// consent page at <routePrefix>/consent. The page backs the OAuth authorize
// redirect: GET <routePrefix>/authorize?... 302s here with an opaque rid,
// the page fetches the stashed request from
// <routePrefix>/authorize/pending, and approves or denies through
// <routePrefix>/authorize/consent — the exact wire shapes
// internal/api/mcp/oauth.go defines for the shared MCP server
// (pendingAuthzResponse, consentRequest, consentResponse, and the
// decisionApprove/decisionDeny values), which the observability gateway
// runs with its own route prefix, audience and supported scopes.
//
// The console session is a bearer token in localStorage, not a cookie, so
// the page attaches it to both fetches; a missing (or rejected) token
// redirects the browser through the console login, which returns here via
// the SPA's paprika_return_to mechanism. A logged-out visitor therefore
// lands on a login page, never on "invalid or expired".
//
// The gateway serves its own page instead of reusing the console SPA's
// consent screen because that screen is hardwired to the /mcp surface — its
// fetch paths, client wiring and branding all assume it. Embedding a minimal
// page here keeps the gateway self-contained; unifying the two consent
// surfaces onto one implementation is follow-up work. The paprika mark is
// embedded as a base64 data URI (consent_mark.go), so even a standalone
// gateway renders full branding with no external asset requests.
func ConsentHandler(routePrefix string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		rid := r.URL.Query().Get("rid")
		if rid == "" {
			http.Error(w, "missing rid", http.StatusBadRequest)
			return
		}
		page := strings.NewReplacer(
			"__GATEWAY_RID__", jsonStringLiteral(rid),
			"__GATEWAY_ROUTE_PREFIX__", jsonStringLiteral(routePrefix),
			"__GATEWAY_MARK__", consentMarkPNGBase64,
		).Replace(consentPageHTML)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// The page embeds one caller-supplied value; no intermediary or back
		// button should keep a cached copy of it.
		w.Header().Set("Cache-Control", "no-store")
		//nolint:gosec,errcheck // G705 taint: rid and routePrefix reach the page only as JSON-marshaled literals (\u-escaped, see jsonStringLiteral), never raw-interpolated; the write itself is best-effort after headers are written.
		_, _ = w.Write([]byte(page))
	})
}

// jsonStringLiteral renders s as a JavaScript string literal safe to embed in
// an inline <script>: encoding/json escapes <, > and &, so a caller-supplied
// rid can never close the script element it lands in. json.Marshal cannot
// fail on a plain string; the fallback keeps that honest.
func jsonStringLiteral(s string) string {
	raw, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(raw)
}

// consentPageHTML is the whole consent surface: markup, styling and script
// inline, no external assets, no framework. __GATEWAY_RID__ and
// __GATEWAY_ROUTE_PREFIX__ are replaced with JSON-marshaled string literals
// before serving — never with raw string interpolation into <script>.
//
// The decision values "approve"/"deny" in the script mirror
// decisionApprove/decisionDeny in internal/api/mcp/oauth.go, and the POST
// body mirrors consentRequest; the /authorize/pending response is read as
// pendingAuthzResponse (an absent valid field with a 200 means valid; a 400
// means invalid or expired; a 401 means the console session is missing or
// rejected and the page redirects to the console login instead).
const consentPageHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paprika Observability Gateway — Authorize</title>
<link rel="icon" href="data:image/png;base64,__GATEWAY_MARK__">
<style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
  color: #1c1b1a;
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  /* Warm paprika gradient underneath, then an 8x8 Bayer-ordered dither tile
     on top — the retro halftone texture that gives this surface its depth.
     Two background layers, no blend modes, so it renders identically
     everywhere. */
  background:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect x='2' width='1' height='1' fill='%23000000' fill-opacity='0.29'/%3E%3Crect x='6' width='1' height='1' fill='%23000000' fill-opacity='0.37'/%3E%3Crect y='2' width='1' height='1' fill='%23000000' fill-opacity='0.44'/%3E%3Crect x='4' y='2' width='1' height='1' fill='%23000000' fill-opacity='0.51'/%3E%3Crect x='2' y='4' width='1' height='1' fill='%23000000' fill-opacity='0.4'/%3E%3Crect x='6' y='4' width='1' height='1' fill='%23000000' fill-opacity='0.33'/%3E%3Crect y='6' width='1' height='1' fill='%23000000' fill-opacity='0.55'/%3E%3Crect x='4' y='6' width='1' height='1' fill='%23000000' fill-opacity='0.48'/%3E%3C/svg%3E") repeat,
    radial-gradient(130% 100% at 50% -10%, #9c2f1c 0%, #6d1d12 46%, #3b110a 100%);
  background-size: 8px 8px, cover;
}
main {
  width: 100%;
  max-width: 470px;
  background: #fffdf8;
  border: 1px solid #e7e3da;
  border-radius: 16px;
  padding: 30px 30px 24px;
  box-shadow: 0 24px 64px rgba(20, 6, 3, 0.45);
}
header.brand {
  display: flex;
  gap: 14px;
  align-items: center;
  margin: 0 0 6px;
}
header.brand img {
  width: 56px;
  height: 56px;
  flex: none;
  filter: drop-shadow(0 4px 10px rgba(59, 17, 10, 0.35));
}
h1 { font-size: 19px; margin: 0; letter-spacing: -0.01em; }
p.sub { margin: 2px 0 0; color: #5b5852; font-size: 13.5px; }
#status { margin: 14px 0 0; color: #8a3b12; min-height: 1.2em; }
#client-line { margin: 6px 0 12px; }
#client-line code { word-break: break-all; }
fieldset {
  border: 1px solid #e4e2dd;
  border-radius: 8px;
  margin: 0 0 12px;
  padding: 10px 14px;
}
fieldset label { display: flex; gap: 8px; align-items: center; padding: 4px 0; }
fieldset span { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
p.info { color: #5b5852; font-size: 13px; margin: 0 0 16px; }
.actions { display: flex; gap: 10px; }
button {
  flex: 1;
  border: 0;
  border-radius: 9px;
  padding: 11px 14px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  background: #b23a2f;
  color: #ffffff;
  transition: background 0.15s ease, transform 0.05s ease;
}
button:hover { background: #9c3227; }
button:active { transform: translateY(1px); }
button.secondary { background: #eceae5; color: #1c1b1a; }
button.secondary:hover { background: #e0ddd6; }
button:disabled { opacity: 0.6; cursor: default; }
section.connect {
  margin: 20px 0 0;
  padding: 16px 0 0;
  border-top: 1px dashed #ddd8cd;
}
section.connect h2 {
  margin: 0 0 10px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #8a3b12;
}
.endpoint-row { display: flex; gap: 8px; align-items: stretch; margin: 0 0 10px; }
code.block {
  flex: 1;
  display: block;
  background: #f4f1ea;
  border: 1px solid #e4e2dd;
  border-radius: 7px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  word-break: break-all;
  color: #3f3d3a;
}
button.copy {
  flex: none;
  padding: 0 12px;
  font-size: 12.5px;
  background: #eceae5;
  color: #1c1b1a;
}
button.copy:hover { background: #e0ddd6; }
p.hint { margin: 0 0 10px; color: #5b5852; font-size: 12.5px; }
p.hint code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; word-break: break-all; }
a.docs {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #b23a2f;
  font-weight: 600;
  font-size: 13.5px;
  text-decoration: none;
}
a.docs:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <header class="brand">
    <img src="data:image/png;base64,__GATEWAY_MARK__" alt="Paprika mark" width="56" height="56">
    <div>
      <h1>Paprika Observability Gateway</h1>
      <p class="sub">An application is asking to access this gateway.</p>
    </div>
  </header>
  <div id="status" role="status" aria-live="polite"></div>
  <section id="consent" hidden>
    <p id="client-line"></p>
    <fieldset id="scopes"><legend>Requested access</legend></fieldset>
    <p class="info">Granting this access allows the application to read logs, metrics, and traces through the observability providers configured in this cluster. It cannot change anything.</p>
    <div class="actions">
      <button id="approve" type="button">Approve</button>
      <button id="deny" type="button" class="secondary">Deny</button>
    </div>
  </section>
  <section class="connect">
    <h2>Connect your own MCP client</h2>
    <div class="endpoint-row">
      <code class="block" id="endpoint"></code>
      <button id="copy-endpoint" type="button" class="copy">Copy</button>
    </div>
    <p class="hint">For example <code id="claude-cmd"></code> — Claude and Codex also self-register on first connect. Tokens carry the <code>paprika:observe</code> scope and can be revoked any time from the console.</p>
    <a class="docs" href="https://github.com/paprikacd/paprika/blob/master/docs/guides/observability-gateway.md" target="_blank" rel="noopener noreferrer">Observability gateway documentation</a>
  </section>
</main>
<script>
"use strict";

var gatewayRid = __GATEWAY_RID__;
var gatewayRoutePrefix = __GATEWAY_ROUTE_PREFIX__;
var gatewayEndpoint = window.location.origin + gatewayRoutePrefix + "/mcp";

// Fill the connect panel from this deployment's own URL so the instructions
// always match the surface the user is looking at.
var endpointEl = document.getElementById("endpoint");
if (endpointEl) { endpointEl.textContent = gatewayEndpoint; }
var cmdEl = document.getElementById("claude-cmd");
if (cmdEl) { cmdEl.textContent = "claude mcp add paprika-observe --transport http " + gatewayEndpoint; }
var copyBtn = document.getElementById("copy-endpoint");
if (copyBtn) {
  copyBtn.addEventListener("click", function () {
    navigator.clipboard.writeText(gatewayEndpoint).then(function () {
      copyBtn.textContent = "Copied";
      setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
    });
  });
}

var statusEl = document.getElementById("status");
var consentEl = document.getElementById("consent");
var busy = false;

// renderMessage shows a plain, non-technical outcome line — every failure
// path funnels here, so a user never sees a stack trace or a status code.
function renderMessage(text) {
  statusEl.textContent = text;
  consentEl.hidden = true;
}

function renderInvalid() {
  renderMessage("This authorization request is invalid or expired. Start a new connection from your MCP client.");
}

function setBusy(next) {
  busy = next;
  document.getElementById("approve").disabled = next;
  document.getElementById("deny").disabled = next;
}

// The page authenticates like the console's own MCP consent screen
// (ui/src/app/mcp/consent): the console session is a paprika-api bearer token
// in localStorage, not a cookie, so the fetches below attach it explicitly.
// A missing token sends the user through the console login instead of
// failing: the paprika_return_to key is the same contract the SPA's login
// flow consumes to navigate back here after the OIDC round trip.
function consoleToken() {
  try {
    return localStorage.getItem("paprika_id_token");
  } catch (err) {
    return null;
  }
}

function goLogin() {
  try {
    localStorage.setItem("paprika_return_to", window.location.pathname + window.location.search);
  } catch (err) { /* storage unavailable: the login round trip still works, it just won't return here */ }
  window.location.assign("/login/");
}

function authHeaders(extra) {
  var headers = extra || {};
  var token = consoleToken();
  if (token) {
    headers["Authorization"] = "Bearer " + token;
  }
  return headers;
}

function start() {
  // No console session at all: log in first, come back here afterwards.
  // Without this the pending fetch below would 401 and this page would
  // render "invalid or expired" for every logged-out visitor.
  if (!consoleToken()) {
    goLogin();
    return;
  }
  fetch(gatewayRoutePrefix + "/authorize/pending?rid=" + encodeURIComponent(gatewayRid), {
    credentials: "same-origin",
    headers: authHeaders()
  }).then(function (resp) {
    if (resp.status === 401) {
      // A stored token the console authenticator rejects (expired or
      // revoked): a fresh login round trip fixes it. A genuinely bad or
      // expired rid is a 400 from the same endpoint and renders invalid.
      goLogin();
      return null;
    }
    if (!resp.ok) {
      renderInvalid();
      return null;
    }
    return resp.json();
  }).then(function (rec) {
    if (rec === null) {
      return;
    }
    // Mirrors pendingAuthzResponse: no client_id means nothing valid to
    // consent to (valid:false, an expired rid, or an unknown shape all land
    // here — the server fails closed on each).
    if (!rec || rec.valid === false || !rec.client_id) {
      renderInvalid();
      return;
    }
    render(rec);
  }).catch(function () {
    renderMessage("The gateway could not be reached. Please try again.");
  });
}

// render fills the consent form. Every server-supplied string lands via
// textContent / input.value — never innerHTML — so a hostile client_id or
// scope cannot inject markup.
function render(rec) {
  var clientCode = document.createElement("code");
  clientCode.textContent = rec.client_id;
  var clientLine = document.getElementById("client-line");
  clientLine.textContent = "Application ";
  clientLine.appendChild(clientCode);
  clientLine.appendChild(document.createTextNode(" requests the following access."));

  var scopes = String(rec.scope || "").split(/\s+/).filter(Boolean);
  if (scopes.length === 0) {
    // This surface grants only paprika:observe; a request that asked for
    // nothing still consents to exactly that.
    scopes = ["paprika:observe"];
  }
  var box = document.getElementById("scopes");
  scopes.forEach(function (scope) {
    var label = document.createElement("label");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "scope";
    cb.value = scope;
    cb.checked = true;
    var span = document.createElement("span");
    span.textContent = scope;
    label.appendChild(cb);
    label.appendChild(span);
    box.appendChild(label);
  });

  document.getElementById("approve").addEventListener("click", function () { decide(rec, "approve"); });
  document.getElementById("deny").addEventListener("click", function () { decide(rec, "deny"); });
  consentEl.hidden = false;
}

function checkedScopes() {
  var boxes = document.querySelectorAll('input[name="scope"]:checked');
  var out = [];
  for (var i = 0; i < boxes.length; i++) {
    out.push(boxes[i].value);
  }
  return out;
}

// decide POSTs the consent decision. The "approve"/"deny" values mirror
// decisionApprove/decisionDeny in internal/api/mcp/oauth.go, and the body
// mirrors consentRequest; both outcomes answer with consentResponse's
// redirectTo, which is the only navigation target the page ever follows.
function decide(rec, decision) {
  if (busy) {
    return;
  }
  setBusy(true);
  renderMessage("Processing\u2026");

  var body = {
    client_id: rec.client_id,
    redirect_uri: rec.redirect_uri,
    state: rec.state,
    code_challenge: rec.code_challenge,
    code_challenge_method: rec.code_challenge_method,
    scopes: checkedScopes(),
    decision: decision
  };

  fetch(gatewayRoutePrefix + "/authorize/consent", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body)
  }).then(function (resp) {
    if (resp.status === 401) {
      // Session expired between loading this page and deciding.
      goLogin();
      return null;
    }
    if (!resp.ok) {
      renderMessage("The request could not be completed. Please close this page and try again.");
      return null;
    }
    return resp.json();
  }).then(function (resp) {
    if (resp === null) {
      return;
    }
    // consentResponse answers with the camelCase redirectTo the shared MCP
    // server mints (internal/api/mcp/oauth.go) — the only navigation target
    // the page ever follows.
    if (resp && typeof resp.redirectTo === "string" && resp.redirectTo) {
      window.location.assign(resp.redirectTo);
      return;
    }
    renderMessage("Something went wrong. Please close this page and try again.");
  }).catch(function () {
    setBusy(false);
    renderMessage("The gateway could not be reached. Please try again.");
  });
}

start();
</script>
</body>
</html>`
