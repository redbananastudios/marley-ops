import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tie assets, navigations and Server Actions to one deployed image. Next.js
  // hard-reloads a stale client when the SHA changes, preventing version-skew
  // failures during the container handover.
  deploymentId: process.env.NEXT_PUBLIC_BUILD_SHA,

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
    // Resource-restricting CSP built from the app's actual browser origins.
    // script/style-src need 'unsafe-inline' (Next injects inline hydration/RSC
    // bootstrap without nonces) and 'unsafe-eval' (Turbopack HMR in dev + some
    // libs); a nonce-based tightening of script-src is a tracked follow-up.
    // connect/img/media are pinned to Supabase + R2; frame-src allows the Google
    // Maps directions embed; form-action allows the takepayments hosted page.
    let supaHttps = "";
    let supaWs = "";
    try {
      const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "");
      supaHttps = u.origin;
      supaWs = `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`;
    } catch {
      /* no Supabase URL at build → connect/img fall back to self only */
    }
    const R2 = "https://*.r2.cloudflarestorage.com";
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self' https://gw1.tponlinepayments.com",
      "frame-src 'self' https://www.google.com https://maps.google.com",
      // cdnjs: pdfmake (client-side job-sheet / contractor-statement PDF rendering).
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      `img-src 'self' data: blob: ${supaHttps} ${R2}`,
      `media-src 'self' blob: ${supaHttps} ${R2}`,
      `connect-src 'self' ${supaHttps} ${supaWs}`,
      "worker-src 'self' blob:",
    ]
      .map((d) => d.replace(/\s+/g, " ").trim())
      .join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
