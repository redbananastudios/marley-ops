import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosted on the OVH VPS via Docker: emit a standalone server bundle
  // (minimal runtime, no full node_modules) that `node server.js` runs.
  output: "standalone",

  // pdfmake (server-side crew job-sheet rendering) pulls in pdfkit/fontkit,
  // which use dynamic requires + __dirname font lookups that a bundler mangles.
  // Keep it an external runtime require so it's traced into the standalone
  // output untouched.
  serverExternalPackages: ["pdfmake"],

  // i9 is the host; Peter reaches the dev server over Tailscale from his laptop.
  // Next 16 blocks cross-origin dev requests (HMR, server actions) unless the
  // origin is allow-listed — without this, the LAN login hangs / 403s.
  allowedDevOrigins: ["i9", "i9.local", "localhost", "127.0.0.1"],

  // Internal admin panel — must never be indexed (the login page is public).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default nextConfig;
