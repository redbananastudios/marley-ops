import { CUBIC_CATEGORIES } from "@/lib/cubic-catalogue";

export const AI_SURVEY_PROMPT_VERSION = "ai-survey-v1";

const catalogue = CUBIC_CATEGORIES.flatMap((category) =>
  category.items.map((item) => `${item.key} | ${item.title}`),
).join("\n");

export function roomVideoPrompt(roomName: string): string {
  return `You are preparing a UK removals inventory for Marley Moves.
Analyse the complete room video and its narration. Identify every movable item, including repeated chairs, boxes and hidden-storage contents that are actually shown or clearly narrated.

Room: ${roomName}

Rules:
- Use only catalogue keys from the allow-list below. Never invent a key or cubic volume.
- Return up to three ranked catalogue candidates with confidence 0..1 for each observed item.
- Quantity means visually/narratively supported count, not a guess.
- Mark moving=staying when narration says it is not moving; uncertain when unclear.
- Give 1-5 timestamps in seconds where each item is clearest.
- Coverage is poor/partial when the camera is dark, too fast, occluded, or misses meaningful areas.
- Do not count fitted cabinets, worktops, doors, walls, appliances explicitly described as staying, people, paperwork or reflections.

CATALOGUE KEY | TITLE
${catalogue}`;
}

export function importedVideoPrompt(): string {
  return `You are preparing a room-by-room UK removals inventory for Marley Moves.
Analyse the complete property video and narration. First propose non-overlapping room segments, then assign every item to exactly one segmentRef.

Use only catalogue keys from the allow-list. Never invent cubic volume. Apply conservative evidence-based quantities, moving/staying narration, quality flags and 1-5 evidence timestamps per item.

CATALOGUE KEY | TITLE
${catalogue}`;
}

export function photoPrompt(roomName: string): string {
  return `You are preparing a UK removals inventory for Marley Moves from room photos.
Room: ${roomName}
Identify movable items across the supplied photos. Use only catalogue keys below, never volume. Use photoIndex and optional normalised 0..1000 box2d evidence. Avoid double-counting an item visible in overlapping photos.

CATALOGUE KEY | TITLE
${catalogue}`;
}
