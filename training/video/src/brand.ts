/** Marley brand tokens for the training video (mirrors app globals.css). */
import { loadFont as loadCormorant } from "@remotion/google-fonts/CormorantGaramond";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";

export const COLORS = {
  charcoal: "#1F1D1B", // capture-sheet ground / app --charcoal
  charcoalCard: "#2A2D33",
  red: "#C03838", // --mm-red
  redBright: "#E24A4A",
  redDeep: "#9E2B2B",
  cream: "#FAF7F2",
  white: "#FFFFFF",
  mist400: "#8A8D94",
  mist300: "#B7BAC0",
  survey: "#2F9C95", // teal survey accent
  cardBorder: "rgba(255,255,255,0.10)",
} as const;

export const brand = loadCormorant().fontFamily; // wordmark (Cormorant Garamond)
export const sans = loadInter().fontFamily; // body / display

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
