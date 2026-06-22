import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // i9 is the host; Peter reaches the dev server over Tailscale from his laptop.
  // Next 16 blocks cross-origin dev requests (HMR, server actions) unless the
  // origin is allow-listed — without this, the LAN login hangs / 403s.
  allowedDevOrigins: ["i9", "i9.local", "localhost", "127.0.0.1"],
};

export default nextConfig;
