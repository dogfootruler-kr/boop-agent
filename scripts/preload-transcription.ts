#!/usr/bin/env tsx
// Tiny one-shot to download + warm the local transcription model. Used by
// `npm run setup`, by the dashboard's "Download now" button, and by the user
// manually if they want to pre-cache.
import { getLocalTranscriber } from "../server/audio/local-whisper.js";
import { describeTranscriber, getTranscriptionSettings } from "../server/audio/settings.js";

async function main() {
  const settings = await getTranscriptionSettings();
  if (settings.provider === "remote") {
    console.log(`[preload] a transcription endpoint is configured (${describeTranscriber(settings)}).`);
    console.log("[preload] Nothing to download - that endpoint owns the model.");
    return;
  }
  console.log(`[preload] warming local transcription model ${settings.localModel}…`);
  const start = Date.now();
  await getLocalTranscriber(settings.localModel);
  console.log(`[preload] ready in ${Date.now() - start}ms`);
}

main().catch((err) => {
  console.error("[preload] failed:", err);
  process.exit(1);
});
