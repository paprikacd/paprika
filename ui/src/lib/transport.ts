"use client"

import { createConnectTransport } from "@connectrpc/connect-web"

const AUTH_TOKEN_KEY = "paprika_id_token"
const AUTH_USER_KEY = "paprika_auth_user"

function clearStaleAuth() {
  localStorage.removeItem(AUTH_TOKEN_KEY)
  localStorage.removeItem(AUTH_USER_KEY)
  if (window.location.pathname !== "/login/") {
    window.location.href = "/login/"
  }
}

export function createTransport() {
  return createConnectTransport({
    baseUrl: "",
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      const token = localStorage.getItem(AUTH_TOKEN_KEY)
      if (token) {
        headers.set("Authorization", `Bearer ${token}`)
      }
      const res = await fetch(input, { ...init, headers })
      if (res.status === 401) {
        clearStaleAuth()
      }
      return res
    },
  })
}
