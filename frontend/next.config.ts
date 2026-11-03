import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  devIndicators: false,
  // Next 16's CLI checker can lose `tsc --showConfig` output in containerized
  // builds. TypeScript 5.9 still provides the compiler API, so use that stable
  // path for reproducible local and Render builds.
  experimental: {
    useTypeScriptCli: false,
  },
};
export default config;
