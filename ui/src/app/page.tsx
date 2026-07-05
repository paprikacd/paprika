"use client"

import { useEffect } from "react"
import { useAuth } from "@/lib/auth-context"

export default function HomePage() {
  const { user, isLoading } = useAuth()

  useEffect(() => {
    if (isLoading) return
    const target = user ? "/dashboard/" : "/login/"
    const current = window.location.pathname.replace(/\/+$/, "")
    const dest = target.replace(/\/+$/, "")
    if (current === dest) return
    window.location.href = target
  }, [isLoading, user])

  return null
}
