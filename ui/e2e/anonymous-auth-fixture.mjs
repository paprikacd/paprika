// These isolated Insights fixtures have no interactive authentication or refresh
// endpoint. Describe that deployment mode through the production public contract;
// do not inject a session or bypass the application's session bootstrap.
const configuration = JSON.stringify({
  oidc: { enabled: false, provider: "oidc", label: "Single sign-on" },
  basic: { enabled: false },
  session: { refreshEnabled: false },
})

function publicConfiguration(method) {
  return {
    status: method === "GET" ? 200 : 405,
    headers: { "content-type": method === "GET" ? "application/json" : "text/plain", "cache-control": "no-store" },
    body: method === "GET" ? configuration : "method not allowed",
  }
}

export function serveAnonymousAuthConfiguration(request, response) {
  if (new URL(request.url, "http://localhost").pathname !== "/auth/config") return false
  const result = publicConfiguration(request.method)
  response.writeHead(result.status, result.headers)
  response.end(result.body)
  return true
}

export async function routeAnonymousAuthConfiguration(page) {
  await page.route("**/auth/config", route => route.fulfill(publicConfiguration(route.request().method())))
}
