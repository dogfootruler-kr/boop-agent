/**
 * The dashboard's control surface for voice notes.
 *
 * Shaped like `server/apple-routes.ts`: localhost only, every response is the
 * full status so the UI never has to guess what a write did, and every write
 * clears the settings cache so the next voice note uses what was just chosen.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { isLocalBrowserControlRequest } from "../browser-routes.js";
import { checkTranscriber, forgetTranscriberProbe, type TranscriberStatus } from "./health.js";
import { preloadLocalTranscriber } from "./local-whisper.js";
import {
  DEFAULT_LOCAL_MODEL,
  DEFAULT_REMOTE_MODEL,
  getTranscriptionSettings,
  LOCAL_MODEL_CHOICES,
  saveTranscriptionSettings,
  type TranscriptionSettings,
} from "./settings.js";

interface TranscriptionStatusResponse {
  readonly settings: TranscriptionSettings;
  readonly status: TranscriberStatus;
  readonly localModelChoices: typeof LOCAL_MODEL_CHOICES;
  readonly defaults: { localModel: string; remoteModel: string };
}

function requireLocalTranscriptionControl(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isLocalBrowserControlRequest(req.headers, req.socket.remoteAddress ?? "")) {
    next();
    return;
  }
  res.status(403).json({
    ok: false,
    error: "Transcription settings are only available from localhost.",
  });
}

async function transcriptionStatus(
  settings?: TranscriptionSettings,
): Promise<TranscriptionStatusResponse> {
  const active = settings ?? (await getTranscriptionSettings());
  return {
    settings: active,
    status: await checkTranscriber(active),
    localModelChoices: LOCAL_MODEL_CHOICES,
    defaults: { localModel: DEFAULT_LOCAL_MODEL, remoteModel: DEFAULT_REMOTE_MODEL },
  };
}

export function createTranscriptionRouter(): express.Router {
  const router = express.Router();
  router.use(requireLocalTranscriptionControl);

  router.get("/status", async (_req, res) => {
    try {
      res.json(await transcriptionStatus());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/settings", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const text = (key: string): string | undefined =>
        typeof body[key] === "string" ? (body[key] as string) : undefined;

      const url = text("url");
      if (url !== undefined && url.trim() && !isHttpUrl(url)) {
        res.status(400).json({ ok: false, error: "The endpoint must be an http(s) URL." });
        return;
      }

      const settings = await saveTranscriptionSettings({
        url,
        model: text("model"),
        localModel: text("localModel"),
        language: text("language"),
      });
      // The probe is about a transcriber that may have just changed.
      forgetTranscriberProbe();
      res.json(await transcriptionStatus(settings));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Start the model download without waiting for it.
   *
   * Answering immediately rather than holding the request open for a
   * multi-hundred-megabyte fetch: the dashboard polls `/status` for `warm`,
   * which is a truer signal than "the POST returned".
   */
  router.post("/preload", async (_req, res) => {
    try {
      const settings = await getTranscriptionSettings();
      if (settings.provider === "remote") {
        res.status(400).json({
          ok: false,
          error: "An endpoint is configured, so there is no local model to download.",
        });
        return;
      }
      preloadLocalTranscriber(settings.localModel);
      forgetTranscriberProbe();
      res.json(await transcriptionStatus(settings));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/recheck", async (_req, res) => {
    try {
      forgetTranscriberProbe();
      res.json(await transcriptionStatus());
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
