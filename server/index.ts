import "./env-setup.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { addClient } from "./broadcast.js";
import { createSendblueRouter } from "./sendblue.js";
import { createWhatsappRouter } from "./openwa/webhook.js";
import { createTelegramRouter } from "./telegram/webhook.js";
import { ensureTelegramWebhook } from "./telegram/webhook-registration.js";
import { ensureWhatsappWebhook } from "./openwa/webhook-registration.js";
import { handleUserMessage } from "./interaction-agent.js";
import { loadIntegrations } from "./integrations/registry.js";
import { loadChannels } from "./channels/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { cancelAgent, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";
import { ensureProactiveWatcher } from "./proactive-email.js";
import { preloadLocalModel } from "./embeddings.js";
import { checkTranscriber } from "./audio/health.js";
import { preloadLocalTranscriber } from "./audio/local-whisper.js";
import { activeTranscriptionProvider, describeTranscriber } from "./audio/transcribe.js";
import { isTelegramConfigured } from "./telegram/config.js";
import { createMemoryRouter } from "./memory-routes.js";
import { createBrowserRouter } from "./browser-routes.js";
import { createAppleRouter } from "./apple-routes.js";
import { closeLocalBrowser } from "./browser/launcher.js";
import { createChangelogRouter } from "./changelog.js";
import {
  getRuntimeConfig,
  resolveModelInput,
  resolveReasoningEffortInput,
  resolveRuntimeInput,
  setCodexReasoningEffort,
  setRuntimeModel,
  setRuntimeProvider,
} from "./runtime-config.js";
import { startImageCleanup } from "./images/clean.js";
import { isPublicServerRequest, isTrustedLocalRequest } from "./local-access.js";

async function main() {
  // Channels are registered separately from Integrations: a Channel is how
  // the user reaches Boop, not a capability the dispatcher can spawn.
  await loadChannels();
  await loadIntegrations();
  startCleanupLoop();
  startAutomationLoop();
  startHeartbeatLoop();
  startConsolidationLoop();
  startImageCleanup();
  // No-op when a paid embedding key is set; otherwise downloads/loads the
  // local BGE-large model in the background so the first user-facing
  // recall() doesn't pay the model-load cost.
  preloadLocalModel();
  // Only when a Channel that can carry a voice note is configured: the model
  // is a download, and someone who never uses Telegram must not pay for one
  // they will never transcribe with.
  if (isTelegramConfigured() && activeTranscriptionProvider() === "local") {
    preloadLocalTranscriber();
  }

  // If a stable public URL is configured, register the Composio webhook +
  // Gmail trigger now. For ngrok-based dev, scripts/dev.mjs drives the same
  // function once the ngrok URL is known, so we skip when only the local
  // PORT default is available.
  const stableUrl = process.env.PUBLIC_URL;
  if (stableUrl && !stableUrl.includes("localhost")) {
    ensureProactiveWatcher(stableUrl).catch((err) =>
      console.error("[proactive] startup failed", err),
    );
  }

  const app = express();
  app.use((req, res, next) => {
    if (isPublicServerRequest(req) || isTrustedLocalRequest(req)) {
      next();
      return;
    }
    res.status(404).json({ error: "not found" });
  });
  app.use(cors());
  // Composio webhook receiver must read raw bytes for HMAC verification, so
  // its body parser is mounted BEFORE the global express.json. Without this
  // ordering the JSON parser consumes the stream first and the raw buffer
  // arrives empty.
  app.use("/composio/webhook", express.raw({ type: "application/json", limit: "2mb" }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", async (_req, res) => {
    // The transcriber probe is cached, so polling this endpoint does not
    // hammer whatever is on the other end of BOOP_TRANSCRIBE_URL.
    res.json({ ok: true, service: "boop-agent", transcription: await checkTranscriber() });
  });

  app.get("/runtime-config", async (_req, res) => {
    try {
      res.json(await getRuntimeConfig());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/runtime-config", async (req, res) => {
    try {
      const body = req.body as {
        runtime?: unknown;
        model?: unknown;
        reasoningEffort?: unknown;
      };
      let runtime =
        body.runtime === undefined
          ? undefined
          : resolveRuntimeInput(String(body.runtime));
      if (body.runtime !== undefined && !runtime) {
        res.status(400).json({ error: `Unknown runtime "${String(body.runtime)}"` });
        return;
      }

      if (runtime) {
        await setRuntimeProvider(runtime);
      }

      runtime ??= (await getRuntimeConfig()).runtime;

      if (body.model !== undefined) {
        const model = resolveModelInput(String(body.model), runtime);
        if (!model) {
          res
            .status(400)
            .json({ error: `Unknown ${runtime} model "${String(body.model)}"` });
          return;
        }
        await setRuntimeModel(model, runtime);
      }

      if (body.reasoningEffort !== undefined) {
        const effort = resolveReasoningEffortInput(String(body.reasoningEffort));
        if (!effort) {
          res.status(400).json({
            error: `Unknown Codex reasoning effort "${String(body.reasoningEffort)}"`,
          });
          return;
        }
        await setCodexReasoningEffort(effort);
      }

      res.json(await getRuntimeConfig());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.use("/sendblue", createSendblueRouter());
  // The `whatsapp` Channel's inbound path. Reachable from loopback and from
  // the tailnet only; `server/local-access.ts` holds that restriction, next to
  // the public-path allowlist it is paired with.
  app.use("/whatsapp", createWhatsappRouter());
  // The `telegram` Channel's inbound path. Telegram's servers call it over the
  // public internet, so unlike `/whatsapp/webhook` it carries no source-address
  // restriction; the derived secret token and the Allowlist are the boundary.
  app.use("/telegram", createTelegramRouter());
  app.use("/composio", createComposioRouter());
  app.use("/memory", createMemoryRouter());
  app.use("/browser", createBrowserRouter());
  app.use("/apple", createAppleRouter());
  app.use("/changelog", createChangelogRouter());

  app.post("/agents/:id/cancel", (req, res) => {
    const ok = cancelAgent(req.params.id);
    res.json({ ok });
  });

  app.post("/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/agents/:id/retry", async (req, res) => {
    const result = await retryAgent(req.params.id);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Chat endpoint for local testing and the debug dashboard
  app.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }
    try {
      const reply = await handleUserMessage({
        conversationId,
        content,
        persistAssistantReply: true,
      });
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, request) => {
    if (!isTrustedLocalRequest(request)) {
      ws.close(1008, "local connections only");
      return;
    }
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`boop-agent server listening on :${port}`);
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/chat`);
    console.log(`  sendblue    POST http://localhost:${port}/sendblue/webhook`);
    console.log(`  whatsapp    POST http://localhost:${port}/whatsapp/webhook`);
    console.log(`  telegram    POST http://localhost:${port}/telegram/webhook`);
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);

    // Said out loud at boot because it is the one thing about voice notes
    // that is invisible otherwise: which model heard you, and whether it is
    // this machine or somewhere else.
    if (isTelegramConfigured()) {
      void checkTranscriber().then((status) => {
        const line = `[transcribe] ${describeTranscriber()} - ${status.state}`;
        if (status.state === "unreachable") console.warn(`${line}: ${status.detail ?? ""}`);
        else console.log(status.detail ? `${line} (${status.detail})` : line);
      });
    }

    // Tell the WhatsApp gateway where to deliver inbound messages, once the
    // port it will be told about is actually accepting connections. Fired and
    // forgotten on purpose: it never rejects, it is silent when WhatsApp is
    // unconfigured, and a gateway that is down must not stop Boop starting.
    void ensureWhatsappWebhook({ port });

    // Point Telegram at this Boop, once the port it will be told about is
    // actually accepting connections. Only possible with a stable public URL:
    // Telegram calls in from the internet, so for a rotating tunnel it is
    // `scripts/dev.mjs` that drives the same function once the URL is known.
    // Fired and forgotten for the same reasons as WhatsApp's.
    const telegramUrl = process.env.PUBLIC_URL;
    if (telegramUrl && telegramUrl.startsWith("https://")) {
      void ensureTelegramWebhook(telegramUrl).then((result) => {
        if (result.ok) console.log(`[telegram] webhook ${result.state}: ${result.url}`);
        else console.warn(`[telegram] webhook registration failed: ${result.reason}`);
      });
    }
  });

  const signalExitCodes = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 } as const;
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      closeLocalBrowser()
        .catch(() => undefined)
        .finally(() => process.exit(signalExitCodes[sig]));
    });
  }
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
