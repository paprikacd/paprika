import type { Metadata } from "next"
import { Instrument_Sans, JetBrains_Mono } from "next/font/google"
import "./globals.css"
import { Nav } from "@/components/layout/nav"
import { AuthProvider } from "@/lib/auth-context"
import { ConnectionProvider } from "@/lib/connection-context"

const instrumentSans = Instrument_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
})

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
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
      className={`${instrumentSans.variable} ${jetbrainsMono.variable} h-full antialiased dark`}
      style={{ colorScheme: "dark" }}
    >
      <body className="min-h-full flex flex-col">
        <AuthProvider>
          <ConnectionProvider>
            <Nav />
            <main className="flex-1">
              {children}
            </main>
          </ConnectionProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
