#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const generated = resolve(root, "convex", "_generated", "api.js");

if (!existsSync(generated)) {
  console.error(`
┌─────────────────────────────────────────────────────────────┐
│  Convex types haven't been generated yet.                   │
│                                                             │
│  Run one of these first:                                    │
│    npm run setup           (full interactive setup)         │
│    npx convex dev --once   (just generate types)            │
│                                                             │
│  Both will write convex/_generated/ which the server needs. │
└─────────────────────────────────────────────────────────────┘
`);
  process.exit(1);
}

// --- voice notes: is there anything to transcribe with? --------------------
// A warning, never a failure. Voice notes are optional, and a Boop that will
// not start because a transcriber is cold would be a worse bug than the one
// this is guarding against.
//
// Deliberately env + filesystem only, no imports from server/: this runs as
// plain node before tsx does, and it must stay fast enough that nobody is
// tempted to skip it.
function readEnvFile() {
  const env = {};
  for (const name of [".env.local", ".env"]) {
    const path = resolve(root, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
      // First file wins, matching how server/env-setup.ts layers them.
      if (m && !(m[1] in env)) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

const env = readEnvFile();
const value = (key) => (process.env[key] ?? env[key] ?? "").trim();

// Telegram is the only Channel that carries voice notes today, so this has
// nothing to say to anyone who has not set it up.
if (value("TELEGRAM_BOT_TOKEN")) {
  const remoteUrl = value("BOOP_TRANSCRIBE_URL");
  if (remoteUrl) {
    console.log(
      `voice notes → ${value("BOOP_TRANSCRIBE_MODEL") || "qwen3-asr-0.6b"} at ${remoteUrl}`,
    );
  } else {
    const model = value("BOOP_TRANSCRIBE_LOCAL_MODEL") || "onnx-community/whisper-base";
    const cached = existsSync(resolve(root, "data", "huggingface-cache", model, "onnx"));
    console.log(
      cached
        ? `voice notes → ${model} (in-process, cached)`
        : `voice notes → ${model} (in-process, downloads on first use — ` +
            "`npx tsx scripts/preload-transcription.ts` to fetch it now)",
    );
    // Whisper does not detect the language; unset means it decodes as English,
    // and German audio comes back as confident English nonsense rather than as
    // an error. Worth saying once at start, because nothing downstream will.
    if (!value("BOOP_TRANSCRIBE_LANGUAGE")) {
      console.log(
        "                 BOOP_TRANSCRIBE_LANGUAGE is unset — voice notes are transcribed as English.",
      );
    }
  }
}
