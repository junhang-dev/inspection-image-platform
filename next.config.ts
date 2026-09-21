import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  agentRules: false,
  experimental: { proxyClientMaxBodySize: "210mb", proxyTimeout: 180000 },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_INTERNAL_BASE_URL || "http://127.0.0.1:4000"}/api/:path*`,
      },
    ];
  },
};
export default nextConfig;
