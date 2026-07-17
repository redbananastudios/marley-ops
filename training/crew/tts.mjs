/**
 * Narration -> ElevenLabs TTS with character timestamps -> per-section mp3 +
 * word-level caption timings. Reads crew/narration.md (## section blocks),
 * writes crew/audio/<id>.mp3 + crew/audio/timeline.json (consumed by both
 * record.ts, to hold each take long enough, and the Remotion comp, for
 * sequence durations + word-synced captions).
 *
 * Voice: "George" JBFqnCBsd6RMkjVDRZzb, model eleven_multilingual_v2
 * (Marley's chosen brand voice — role-training-materials skill, 2026-07-16).
 *
 * Key: ELEVENLABS_API_KEY env var, else read from credentials.env
 * (F:\My Drive\workspace\credentials.env). Never printed.
 *
 * Run from training/:  node crew/tts.mjs           (skips unchanged sections)
 *                      node crew/tts.mjs --force   (regenerate everything)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const audioDir = path.join(here, "audio");
const narrationPath = path.join(here, "narration.md");
const timelinePath = path.join(audioDir, "timeline.json");

const VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George
const MODEL_ID = "eleven_multilingual_v2";
const FORCE = process.argv.includes("--force");

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const credPath = process.env.CREDENTIALS_ENV || "F:\\My Drive\\workspace\\credentials.env";
  const line = readFileSync(credPath, "utf8")
    .split("\n")
    .find((l) => l.startsWith("ELEVENLABS_API_KEY="));
  if (!line) throw new Error("ELEVENLABS_API_KEY not found (env or credentials.env)");
  return line.slice("ELEVENLABS_API_KEY=".length).replace(/\r/g, "").trim();
}

/** Parse narration.md into [{ id, text }] from its `## id` blocks. */
function parseNarration() {
  const md = readFileSync(narrationPath, "utf8");
  const sections = [];
  const re = /^## ([a-z0-9-]+)\s*\n([\s\S]*?)(?=^## |\n*$(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    const text = m[2].trim().replace(/\s+/g, " ");
    if (text) sections.push({ id: m[1], text });
  }
  if (!sections.length) throw new Error("No ## sections found in narration.md");
  return sections;
}

/** Character alignment -> word timings ({ text, startSec, endSec }[]). */
function wordsFromAlignment(alignment) {
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  const words = [];
  let cur = null;
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) {
      if (cur) words.push(cur);
      cur = null;
    } else {
      if (!cur) cur = { text: "", startSec: starts[i], endSec: ends[i] };
      cur.text += chars[i];
      cur.endSec = ends[i];
    }
  }
  if (cur) words.push(cur);
  return words;
}

async function ttsSection(key, { id, text }) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: MODEL_ID }),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status} for "${id}": ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const audio = Buffer.from(json.audio_base64, "base64");
  writeFileSync(path.join(audioDir, `${id}.mp3`), audio);
  const words = wordsFromAlignment(json.alignment);
  const durationSec = json.alignment.character_end_times_seconds.at(-1) ?? 0;
  return { id, file: `${id}.mp3`, textHash: hash(text), durationSec, words };
}

const hash = (t) => createHash("sha256").update(t).digest("hex").slice(0, 16);

mkdirSync(audioDir, { recursive: true });
const prev = existsSync(timelinePath) ? JSON.parse(readFileSync(timelinePath, "utf8")) : [];
const prevById = new Map(prev.map((s) => [s.id, s]));
const key = apiKey();
const sections = parseNarration();

const out = [];
let generated = 0;
for (const s of sections) {
  const old = prevById.get(s.id);
  const mp3There = existsSync(path.join(audioDir, `${s.id}.mp3`));
  if (!FORCE && old && old.textHash === hash(s.text) && mp3There) {
    out.push(old);
    console.log(`skip   ${s.id} (unchanged)`);
    continue;
  }
  const entry = await ttsSection(key, s);
  out.push(entry);
  generated++;
  console.log(`tts    ${s.id}  ${entry.durationSec.toFixed(1)}s  ${entry.words.length} words`);
}

writeFileSync(timelinePath, JSON.stringify(out, null, 2));
const total = out.reduce((s, x) => s + x.durationSec, 0);
console.log(`\ntimeline.json written — ${out.length} sections, ${generated} generated, ${total.toFixed(1)}s narration`);
