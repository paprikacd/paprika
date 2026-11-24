import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// A hover or focus grace is owned by one place. A host that schedules its own hide reopens the parity gap the
// observation owner closes, so these files may not call setTimeout; tooltip-dismiss.ts and observation-owner.ts may.
const observationTimerRule = {
  selector: "CallExpression[callee.name='setTimeout'], CallExpression[callee.property.name='setTimeout']",
  message: "Schedule hover and focus grace through the observation owner (observation-owner.ts), not with setTimeout in a host.",
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
