import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { badgeVariants } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"

type EncodedSrgb = {
  channels: [number, number, number]
  alpha: number
}

type FocusState = {
  dark: boolean
  invalid: boolean
}

const uiRoot = process.cwd().endsWith(`${path.sep}ui`)
  ? process.cwd()
  : path.resolve(process.cwd(), "ui")
const sourceRoot = path.join(uiRoot, "src")

function clamp(channel: number) {
  return Math.min(1, Math.max(0, channel))
}

function encodeLinearChannel(channel: number) {
  return channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * channel ** (1 / 2.4) - 0.055
}

function decodeEncodedChannel(channel: number) {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4
}

function parseOklch(value: string): EncodedSrgb {
  const match = value.match(
    /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/,
  )
  if (!match) throw new Error(`Unsupported OKLCH color: ${value}`)

  const lightness = Number(match[1])
  const chroma = Number(match[2])
  const hue = Number(match[3]) * (Math.PI / 180)
  const alpha = match[4]
    ? match[4].endsWith("%")
      ? Number.parseFloat(match[4]) / 100
      : Number(match[4])
    : 1
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)

  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b
  const l = lPrime ** 3
  const m = mPrime ** 3
  const s = sPrime ** 3

  // CSS displays out-of-gamut channels at the nearest channel boundary for
  // these palette colors. Clip in linear sRGB before applying its transfer
  // curve, then composite the encoded values exactly as the browser does.
  const linear: [number, number, number] = [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]

  return {
    channels: linear.map(encodeLinearChannel) as [number, number, number],
    alpha,
  }
}

function sourceOver(foreground: EncodedSrgb, background: EncodedSrgb): EncodedSrgb {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha)
  if (alpha === 0) return { channels: [0, 0, 0], alpha: 0 }

  return {
    channels: foreground.channels.map((channel, index) =>
      (channel * foreground.alpha +
        background.channels[index] * background.alpha * (1 - foreground.alpha)) /
      alpha,
    ) as [number, number, number],
    alpha,
  }
}

function luminance(color: EncodedSrgb) {
  const [red, green, blue] = color.channels.map(decodeEncodedChannel)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(first: EncodedSrgb, second: EncodedSrgb) {
  const lighter = Math.max(luminance(first), luminance(second))
  const darker = Math.min(luminance(first), luminance(second))
  return (lighter + 0.05) / (darker + 0.05)
}

function darkTokenValues() {
  const css = readFileSync(path.join(sourceRoot, "app/globals.css"), "utf8")
  const blockStart = css.indexOf(":root.dark")
  if (blockStart < 0) throw new Error("globals.css has no :root.dark block")
  const openingBrace = css.indexOf("{", blockStart)
  let depth = 0
  let closingBrace = -1
  for (let index = openingBrace; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1
    if (css[index] === "}") depth -= 1
    if (depth === 0) {
      closingBrace = index
      break
    }
  }
  if (closingBrace < 0) throw new Error(":root.dark block is not closed")

  const values = new Map<string, EncodedSrgb>()
  const declaration = /--([\w-]+):\s*(oklch\([^;]+\));/g
  const darkBlock = css.slice(openingBrace + 1, closingBrace)
  for (const match of darkBlock.matchAll(declaration)) {
    values.set(match[1], parseOklch(match[2].trim()))
  }
  return values
}

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return productionSourceFiles(fullPath)
    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) return []
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return []
    return [fullPath]
  })
}

function discoveredSemanticTints() {
  const tints = {
    destructive: new Set<number>(),
    success: new Set<number>(),
  }
  const classPattern = /\bbg-(destructive|success)\/(\d+(?:\.\d+)?)\b/g
  for (const file of productionSourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(classPattern)) {
      tints[match[1] as keyof typeof tints].add(Number(match[2]))
    }
  }
  return tints
}

function colorWithOpacity(color: EncodedSrgb, opacity: number): EncodedSrgb {
  return { ...color, alpha: color.alpha * opacity }
}

function indicatorColor(
  className: string,
  colors: Map<string, EncodedSrgb>,
): EncodedSrgb | undefined {
  const utility = className.split(":").at(-1) ?? ""
  const match = utility.match(/^(?:ring|border)-([a-z][\w-]*)(?:\/(\d+(?:\.\d+)?))?$/)
  if (!match) return undefined
  const token = colors.get(match[1])
  if (!token) return undefined
  return colorWithOpacity(token, match[2] ? Number(match[2]) / 100 : 1)
}

function classApplies(className: string, state: FocusState) {
  const prefixes = className.split(":").slice(0, -1)
  const isStateIndicator = prefixes.some(
    (prefix) =>
      prefix === "focus" || prefix === "focus-visible" || prefix === "aria-invalid",
  )
  return isStateIndicator && prefixes.every((prefix) => {
    if (prefix === "dark") return state.dark
    if (prefix === "aria-invalid") return state.invalid
    if (prefix === "focus" || prefix === "focus-visible") return true
    return false
  })
}

function winningIndicators(
  classes: string,
  state: FocusState,
  colors: Map<string, EncodedSrgb>,
) {
  const winners = new Map<"ring" | "border", string>()
  for (const className of classes.split(/\s+/)) {
    if (!classApplies(className, state) || !indicatorColor(className, colors)) continue
    const utility = className.split(":").at(-1) ?? ""
    const kind = utility.startsWith("ring-") ? "ring" : "border"
    winners.set(kind, className)
  }
  return winners
}

function focusClassStrings(sourcePath: string, prefix: "focus" | "focus-visible") {
  const source = readFileSync(path.join(sourceRoot, sourcePath), "utf8")
  const classNames = Array.from(source.matchAll(/className="([^"]+)"/g), (match) => match[1])
  return classNames.flatMap((className, elementIndex) =>
    className
      .split(/\s+/)
      .filter((candidate) => candidate.startsWith(`${prefix}:`))
      .map((candidate) => ({
        className: candidate,
        elementIndex,
      })),
  )
}

function expectIndicatorContrast(
  label: string,
  className: string,
  colors: Map<string, EncodedSrgb>,
) {
  const indicator = indicatorColor(className, colors)
  expect(indicator, `${label}: ${className} should resolve to a dark color token`).toBeDefined()
  expect(indicator!.alpha, `${label}: ${className} should be opaque`).toBe(1)
  for (const surfaceName of ["background", "card", "sidebar-accent"] as const) {
    const surface = colors.get(surfaceName)
    expect(surface, `missing --${surfaceName}`).toBeDefined()
    const displayedIndicator = sourceOver(indicator!, surface!)
    expect(
      contrast(displayedIndicator, surface!),
      `${label}: ${className} over --${surfaceName}`,
    ).toBeGreaterThanOrEqual(3)
  }
}

describe("dark enterprise color tokens", () => {
  it("uses the encoded-sRGB compositing and WCAG luminance math", () => {
    const black: EncodedSrgb = { channels: [0, 0, 0], alpha: 1 }
    const white: EncodedSrgb = { channels: [1, 1, 1], alpha: 1 }
    expect(contrast(black, white)).toBeCloseTo(21, 10)

    const halfWhite = sourceOver({ channels: [1, 1, 1], alpha: 0.5 }, black)
    expect(halfWhite.channels).toEqual([0.5, 0.5, 0.5])
    expect(contrast(halfWhite, black)).toBeCloseTo(5.2808, 4)
  })

  it("keeps semantic text legible on every production tint", () => {
    const colors = darkTokenValues()
    const tints = discoveredSemanticTints()
    expect(tints.destructive.size, "discover destructive production tints").toBeGreaterThan(0)
    expect(tints.success.size, "discover success production tints").toBeGreaterThan(0)

    for (const semantic of ["destructive", "success"] as const) {
      const semanticColor = colors.get(semantic)
      expect(semanticColor, `missing --${semantic}`).toBeDefined()
      for (const tint of tints[semantic]) {
        for (const surfaceName of ["background", "card"] as const) {
          const surface = colors.get(surfaceName)
          expect(surface, `missing --${surfaceName}`).toBeDefined()
          const tintedSurface = sourceOver(
            colorWithOpacity(semanticColor!, tint / 100),
            surface!,
          )
          const renderedText = sourceOver(semanticColor!, tintedSurface)
          expect(
            contrast(renderedText, tintedSurface),
            `text-${semantic} on bg-${semantic}/${tint} over --${surfaceName}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it("keeps every effective Button and Badge focus indicator visible", () => {
    const colors = darkTokenValues()
    const buttonVariantNames = [
      "default",
      "outline",
      "secondary",
      "ghost",
      "destructive",
      "link",
    ] as const
    const badgeVariantNames = [
      "default",
      "secondary",
      "destructive",
      "outline",
      "ghost",
      "link",
    ] as const
    const states: Array<[string, FocusState]> = [
      ["default", { dark: false, invalid: false }],
      ["dark", { dark: true, invalid: false }],
      ["invalid", { dark: false, invalid: true }],
      ["dark invalid", { dark: true, invalid: true }],
    ]

    for (const variant of buttonVariantNames) {
      const classes = buttonVariants({ variant })
      for (const [stateName, state] of states) {
        const winners = winningIndicators(classes, state, colors)
        expect(winners.has("ring"), `Button ${variant} ${stateName} ring`).toBe(true)
        for (const [kind, className] of winners) {
          expectIndicatorContrast(`Button ${variant} ${stateName} ${kind}`, className, colors)
        }
      }
    }

    for (const variant of badgeVariantNames) {
      const classes = badgeVariants({ variant })
      for (const [stateName, state] of states) {
        const winners = winningIndicators(classes, state, colors)
        expect(winners.has("ring"), `Badge ${variant} ${stateName} ring`).toBe(true)
        for (const [kind, className] of winners) {
          expectIndicatorContrast(`Badge ${variant} ${stateName} ${kind}`, className, colors)
        }
      }
    }
  })

  it("keeps command-center and login input indicators visible", () => {
    const colors = darkTokenValues()
    const commandFocus = focusClassStrings(
      "components/dashboard/dashboard-command-center.tsx",
      "focus-visible",
    ).filter(({ className }) => indicatorColor(className, colors))
    const commandInputFocus = focusClassStrings(
      "components/dashboard/dashboard-command-center.tsx",
      "focus",
    ).filter(({ className }) => indicatorColor(className, colors))
    const loginInputFocus = focusClassStrings("app/login/page.tsx", "focus")
      .filter(({ className }) => indicatorColor(className, colors))

    expect(commandFocus.length, "discover command-center focus-visible indicators").toBeGreaterThanOrEqual(2)
    expect(commandInputFocus.length, "discover command-center search indicators").toBeGreaterThanOrEqual(2)
    expect(loginInputFocus.length, "discover both login inputs' ring and border indicators").toBe(4)

    for (const { className, elementIndex } of commandFocus) {
      expectIndicatorContrast(`command control ${elementIndex}`, className, colors)
    }
    for (const { className, elementIndex } of commandInputFocus) {
      expectIndicatorContrast(`command search ${elementIndex}`, className, colors)
    }
    for (const { className, elementIndex } of loginInputFocus) {
      expectIndicatorContrast(`login input ${elementIndex}`, className, colors)
    }

    expectIndicatorContrast("global focus outline", "ring-ring", colors)
    expectIndicatorContrast("sidebar focus outline", "ring-sidebar-ring", colors)
  })
})
