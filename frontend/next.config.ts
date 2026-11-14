import type { NextConfig } from "next";

// The browser only ever talks to this Next.js server. API calls are proxied to
// the Python backend, so weather credentials stay on the backend.
const backend = process.env.COOLLOOP_API_URL ?? "http://127.0.0.1:8000";

const config: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  turbopack: { root: process.cwd() },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default config;
