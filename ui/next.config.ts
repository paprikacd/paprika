import type { NextConfig } from "next";

const basePath = process.env.PAPRIKA_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  distDir: "out",
  basePath,
};

export default nextConfig;
