import { Hero } from "@/components/landing/hero"
import { Features } from "@/components/landing/features"
import { HowItWorks } from "@/components/landing/how-it-works"
import { Comparison } from "@/components/landing/comparison"
import { CTA } from "@/components/landing/cta"

export default function HomePage() {
  return (
    <>
      <Hero />
      <Features />
      <HowItWorks />
      <Comparison />
      <CTA />
      <footer className="border-t border-border/40 py-6">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6">
          <span className="text-xs text-muted-foreground">
            &copy; 2026 Paprika CD
          </span>
          <span className="text-xs text-muted-foreground">
            Apache 2.0 License
          </span>
        </div>
      </footer>
    </>
  )
}
