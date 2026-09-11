import type { Metadata } from "next"
import { Barlow, Barlow_Condensed } from "next/font/google"
import "./globals.css"
import { Nav } from "@/components/layout/nav"
import { AuthProvider } from "@/lib/auth-context"
import { ConnectionProvider } from "@/lib/connection-context"
import { QueryProvider } from "@/lib/query-provider"

const barlow = Barlow({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
})

const barlowCondensed = Barlow_Condensed({
  variable: "--font-cond",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
})

export const metadata: Metadata = {
  title: {
    template: "%s | Paprika",
    default: "Paprika",
  },
  description:
    "Kubernetes-native application delivery platform.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${barlow.variable} ${barlowCondensed.variable} h-full antialiased`}
      style={{ colorScheme: "light" }}
    >
      <body className="min-h-full flex flex-col">
        <AuthProvider>
          <ConnectionProvider>
            <QueryProvider>
              <Nav />
              <div className="flex-1">{children}</div>
            </QueryProvider>
          </ConnectionProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
