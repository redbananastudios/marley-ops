"use client";

/**
 * Last-resort boundary — catches failures in the ROOT layout itself, where
 * app/error.tsx can't help. Must render its own <html>/<body> (no layout
 * exists at this point). Only dependency is the tiny chunk-reload helper so a
 * post-deploy stale-chunk failure here self-heals too.
 */

import { useEffect, useState } from "react";
import { reloadOnceForChunkError } from "@/lib/chunk-reload";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    if (reloadOnceForChunkError(error)) setUpdating(true);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#f6f5f3", color: "#1a1a1a" }}>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
          {updating ? (
            <p style={{ fontSize: 14, color: "#666" }}>Updating to the latest version…</p>
          ) : (
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Marley Ops hit a problem</h1>
            <p style={{ fontSize: 14, color: "#666", lineHeight: 1.6 }}>
              Your data is safe. Reload to carry on; if it keeps happening, tell Peter and quote{" "}
              <strong>{error.digest ?? "no-digest"}</strong>.
            </p>
            <button
              onClick={reset}
              style={{
                marginTop: 20,
                minHeight: 44,
                padding: "0 20px",
                borderRadius: 8,
                border: 0,
                background: "#c03838",
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
          )}
        </main>
      </body>
    </html>
  );
}
