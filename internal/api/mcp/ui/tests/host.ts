import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { applications, connection, health, investigation, launch, logs, result, starfleetConnection, tree } from "./fixtures.ts";
import { identity, object, string } from "../src/model.ts";

const iframe = document.getElementById("app") as HTMLIFrameElement;
const events = document.getElementById("events")!;
let fail = false;
let failMessage = false;
const params = new URLSearchParams(window.location.search);
const activeConnection = params.get("instance") === "starfleet" ? starfleetConnection : connection;
const currentLaunch = { ...launch, ...(params.has("legacy") ? { connection: undefined } : { connection: activeConnection }) };
const record = (message: string) => { events.textContent += `${message}\n`; };
const bridge = new AppBridge(null, { name: "Paprika fixture host", version: "0.2.0" }, {
  serverTools: {}, logging: {}, message: { text: {} }, updateModelContext: { text: {} },
  experimental: { "openai/message": {}, "openai/modelContext": {}, "openai/deepLink": {} },
}, { hostContext: { theme: "light", displayMode: "fullscreen", availableDisplayModes: ["fullscreen"], containerDimensions: { width: 1100, height: 1000 } } });
bridge.oncalltool = async ({ name, arguments: args }) => {
  record(`tool ${name} ${JSON.stringify(args)}`);
  await new Promise((resolve) => setTimeout(resolve, 220));
  const input = object(args);
  if (name === "get_connection") return params.has("legacy") ? { isError: true, content: [{ type: "text", text: "Unknown tool get_connection" }] } : result(activeConnection);
  if (name === "get_application_health") {
    if (fail) return { isError: true, content: [{ type: "text", text: "Health read failed: upstream evidence is unavailable. Refresh to retry." }] };
    return result(health(string(input.name), string(input.namespace)));
  }
  if (name === "get_resource_tree") return result(tree);
  if (name === "investigate") return result(investigation);
  if (name === "get_logs") return result(logs);
  if (name === "open_fleet" || name === "list_applications") {
    const filtered = applications.filter((app) => (!input.namespace || identity(app).namespace === input.namespace) && (!input.search || identity(app).name.includes(string(input.search))));
    const data = { applications: filtered, total: filtered.length };
    if (name === "list_applications") return result({ data });
    return result({ ...currentLaunch, namespace: input.namespace, search: input.search, applications: data });
  }
  return { isError: true, content: [{ type: "text", text: `Unsupported fixture tool ${name}` }] };
};
bridge.onmessage = async (params) => { record(`message ${JSON.stringify(params)}`); return failMessage ? { isError: true } : {}; };
bridge.onupdatemodelcontext = async (params) => { record(`context ${JSON.stringify(params)}`); return { _meta: { "openai/modelContext": { updateId: "fixture-context" } } }; };
bridge.oninitialized = () => {
  record("initialized");
  void bridge.sendToolInput({ arguments: {} }).then(() => bridge.sendToolResult(result(currentLaunch)));
};
bridge.onerror = (error) => record(`host error ${error.message}`);
document.getElementById("dark")!.addEventListener("change", (event) => bridge.setHostContext({ theme: (event.target as HTMLInputElement).checked ? "dark" : "light" }));
document.getElementById("fail")!.addEventListener("change", (event) => { fail = (event.target as HTMLInputElement).checked; });
document.getElementById("fail-message")!.addEventListener("change", (event) => { failMessage = (event.target as HTMLInputElement).checked; });
document.getElementById("foreign-identity")!.addEventListener("click", () => bridge.sendToolResult(result({ ...launch, connection: activeConnection === connection ? starfleetConnection : connection })));
document.getElementById("width")!.addEventListener("input", (event) => { iframe.style.width = `${(event.target as HTMLInputElement).value}px`; iframe.style.maxWidth = "calc(100% - 20px)"; });
document.getElementById("deep-link")!.addEventListener("click", () => bridge.setHostContext({ "openai/deepLink": { url: "/applications/production/storefront" } }));
void bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!)).then(() => { iframe.src = "console.html"; });
