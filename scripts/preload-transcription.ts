#!/usr/bin/env tsx
// Tiny one-shot to download + warm the local Whisper model. Used by
// `npm run setup` and by the user manually if they want to pre-cache.
import { getLocalTranscriber, localModelName } from "../server/audio/local-whisper.js";
import { activeTranscriptionProvider, describeTranscriber } from "../server/audio/transcribe.js";

async function main() {
  if (activeTranscriptionProvider() === "remote") {
    console.log(`[preload] BOOP_TRANSCRIBE_URL is set (${describeTranscriber()}).`);
    console.log("[preload] Nothing to download - that endpoint owns the model.");
    return;
  }
  console.log(`[preload] warming local transcription model ${localModelName()}…`);
  const start = Date.now();
  await getLocalTranscriber();
  console.log(`[preload] ready in ${Date.now() - start}ms`);
}

main().catch((err) => {
  console.error("[preload] failed:", err);
  process.exit(1);
});
