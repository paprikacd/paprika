import type { NextConfig } from "next";

const basePath = process.env.PAPRIKA_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  // Keep compiler/cache files separate from the static export in out/.
  // Sharing the directory lets a production build erase the dev server cache.
  distDir: ".next",
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
