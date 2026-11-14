// Next dev opens an HMR WebSocket from the page, and hydration waits on it. A gateway with no 'upgrade' listener
// hands the upgrade to its request handler, which forwards it to Next. Next answers 101, and Node destroys a 101
// that has no 'upgrade' listener, so the socket never opens. Relay upgrades to the dev server instead.
import { request as httpRequest } from "node:http"

export function proxyWebSocketUpgrades(gateway, targetBase) {
  gateway.on("upgrade", (request, socket, head) => {
    const target = new URL(request.url, targetBase)
    const upstream = httpRequest(target, { method: request.method, headers: { ...request.headers, host: target.host } })
    // Attached before the upstream answers, so a client reset in that window cannot throw in the test process.
    socket.on("error", () => upstream.destroy())
    socket.on("close", () => upstream.destroy())
    upstream.on("upgrade", (result, upstreamSocket, upstreamHead) => {
      const lines = []
      for (let index = 0; index < result.rawHeaders.length; index += 2) lines.push(`${result.rawHeaders[index]}: ${result.rawHeaders[index + 1]}`)
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`)
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) upstreamSocket.write(head)
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
      socket.on("error", () => upstreamSocket.destroy())
      upstreamSocket.on("error", () => socket.destroy())
      upstreamSocket.on("close", () => socket.destroy())
      socket.on("close", () => upstreamSocket.destroy())
    })
    upstream.on("response", result => {
      socket.end(`HTTP/1.1 ${result.statusCode} ${result.statusMessage}\r\n\r\n`)
      result.resume()
    })
    upstream.on("error", () => socket.destroy())
    upstream.end()
  })
}
