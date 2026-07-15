import type { MetadataRoute } from "next";

/**
 * PWA manifest (served at /manifest.webmanifest — the proxy matcher excludes
 * it so the browser can fetch it logged-out). Standalone display is what lets
 * iOS/iPadOS Home-Screen installs receive Web Push at all; icons are the real
 * Marley brand mark (shared with the quotes app), maskable variants padded.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Marley Ops",
    short_name: "Marley Ops",
    description: "Marley Moves internal operations panel",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f4f6f8",
    theme_color: "#18181b",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
