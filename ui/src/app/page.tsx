"use client"

import { useEffect, useRef } from "react"
import { useAuth } from "@/lib/auth-context"

export default function HomePage() {
  const { user, isLoading } = useAuth()
  const directed = useRef(false)

  useEffect(() => {
    if (isLoading || directed.current) return
    directed.current = true
    window.location.href = user ? "/dashboard/" : "/login/"
  }, [isLoading, user])

  return null
}
