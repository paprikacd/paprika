// Next dev opens an HMR WebSocket from the page. A same-origin gateway that answers an upgrade with a plain
// HTTP response leaves that socket hanging, and the page never hydrates. Relay upgrades to the dev server so
// the gateway behaves like the deployed proxy, which forwards WebSockets.
import { request as httpRequest } from "node:http"

export function proxyWebSocketUpgrades(gateway, targetBase) {
  gateway.on("upgrade", (request, socket, head) => {
    const target = new URL(request.url, targetBase)
    const upstream = httpRequest(target, { method: request.method, headers: { ...request.headers, host: target.host } })
    upstream.on("upgrade", (result, upstreamSocket, upstreamHead) => {
      const lines = []
      for (let index = 0; index < result.rawHeaders.length; index += 2) lines.push(`${result.rawHeaders[index]}: ${result.rawHeaders[index + 1]}`)
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`)
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) upstreamSocket.write(head)
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
      socket.on("error", () => upstreamSocket.destroy())
      upstreamSocket.on("error", () => socket.destroy())
    })
    upstream.on("response", result => { socket.end(`HTTP/1.1 ${result.statusCode} ${result.statusMessage}\r\n\r\n`) })
    upstream.on("error", () => socket.destroy())
    upstream.end()
  })
}
