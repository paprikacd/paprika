"use client"

import { createConnectTransport } from "@connectrpc/connect-web"

export function createTransport() {
  return createConnectTransport({
    baseUrl: "",
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      const token = localStorage.getItem("paprika_id_token")
      if (token) {
        headers.set("Authorization", `Bearer ${token}`)
      }
      return fetch(input, { ...init, headers })
    },
  })
}
