import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/layout/nav";
import { ConnectionProvider } from "@/lib/connection-context";
import { AuthProvider } from "@/lib/auth-context";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s | Paprika",
    default: "Paprika — Kubernetes-Native Application Delivery",
  },
  description:
    "Paprika is a Kubernetes-native application delivery platform that consolidates CI/CD pipelines, progressive delivery, traffic routing, and multi-cluster management into a single operator.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
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
  );
}
