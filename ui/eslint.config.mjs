import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// A hover or focus grace is owned by one place. A host that schedules its own hide reopens the parity gap the
// observation owner closes, so these files may not call setTimeout; tooltip-dismiss.ts and observation-owner.ts may.
const observationTimerRule = {
  selector: "CallExpression[callee.name='setTimeout'], CallExpression[callee.property.name='setTimeout']",
  message: "Schedule hover and focus grace through the observation owner (observation-owner.ts), not with setTimeout in a host.",
};

const hexListRule = {
  selector: "ArrayExpression:has(> Literal[value=/^#[0-9a-fA-F]{3,8}$/] ~ Literal[value=/^#[0-9a-fA-F]{3,8}$/])",
  message: "Do not write a list of hex colours here. Use series-palette.ts or the status tokens.",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/features/insights/plugins/**/*.{ts,tsx}", "src/features/insights/**/*-renderers.tsx", "src/features/insights/renderers/**/*.{ts,tsx}", "src/features/insights/stat-sparkline.tsx"],
    ignores: ["src/features/insights/tooltip-dismiss.ts", "src/features/insights/observation-owner.ts", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", observationTimerRule],
    },
  },
  // Series colours come from the palette and roles. A list of literal hex colours is a second palette.
  // Flat config replaces a rule's options per file, so the timer guard is repeated in the two entries below.
  // Renderers and the chart kit import the leaf module they need, never the chart facade (the facade imports them).
  {
    files: ["src/features/insights/renderers/**/*.{ts,tsx}", "src/features/insights/chart-kit/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/chart-renderers", "**/chart-renderers.tsx"],
          message: "Import the renderer or helper from its own module (renderers/* or chart-kit/*), not the chart-renderers facade.",
        }],
      }],
      "no-restricted-syntax": ["error", observationTimerRule, hexListRule],
    },
  },
  // Plugins take the renderers through the chart facade. The first view and the lazy plugin views must reach the chart
  // modules through one module in one order, or Turbopack splits the merged chart scope (measured +1.7 KB JS gzip).
  {
    files: ["src/features/insights/plugins/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/renderers/*"],
          message: "Import renderers from the chart-renderers facade. See the load-order note at the top of the facade.",
        }],
      }],
      "no-restricted-syntax": ["error", observationTimerRule, hexListRule],
    },
  },
  // The Insights shell, renderers and chart kit were split out of 2,600- and 1,100-line files; keep each module small.
  {
    files: ["src/features/insights/shell/**/*.{ts,tsx}", "src/features/insights/renderers/**/*.{ts,tsx}", "src/features/insights/chart-kit/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: { "max-lines": ["error", 500] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
