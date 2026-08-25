#!/usr/bin/env node
// One command to run Boop locally: server + convex + debug dashboard + ngrok.
// Prefixes each child's output so you can tell who's saying what.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// --- preflight: Convex types must exist ----------------------------------
if (!existsSync(resolve(root, "convex/_generated/api.js"))) {
  console.error(`
┌─────────────────────────────────────────────────────────────┐
│  Convex types haven't been generated yet.                   │
│                                                             │
│  Run this first:                                            │
│    npm run setup           (full interactive setup)         │
│    npx convex dev --once   (just generate types)            │
└─────────────────────────────────────────────────────────────┘
`);
  process.exit(1);
}

// --- read PORT from .env.local ------------------------------------------
function readEnv() {
  const p = resolve(root, ".env.local");
  if (!existsSync(p)) return {};
  const env = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const envVars = readEnv();
const port = envVars.PORT || "3456";
const ngrokDomain = envVars.NGROK_DOMAIN || "";
const publicUrl = envVars.PUBLIC_URL || "";

// A `trycloudflare.com` URL is a quick tunnel: it exists only for the lifetime
// of the cloudflared process that created it and is dead the moment that
// process exits. Treating a leftover one as a static URL is what makes a
// restart look configured while nothing can actually reach the server, so it
// is deliberately not counted as one - the tunnel gets relaunched and the
// fresh URL replaces it.
const isEphemeralUrl = (url) =>
  !url ||
  url.includes("localhost") ||
  url.includes("127.0.0.1") ||
  url.includes("trycloudflare.com");
const hasStaticUrl = Boolean(publicUrl) && !isEphemeralUrl(publicUrl);

// Which tunnel to bring up, if any. `auto` prefers ngrok when it is installed
// and falls back to cloudflared, which needs no account for a quick tunnel.
// A reserved ngrok domain forces ngrok: it is the only provider that can serve
// it. A genuinely static PUBLIC_URL means the user is running their own
// tunnel and Boop should not start a second one.
// `process.env` first so a one-off `BOOP_TUNNEL=cloudflared npm run dev` works
// without editing .env.local, which is where the persistent choice belongs.
const tunnelPreference = (process.env.BOOP_TUNNEL || envVars.BOOP_TUNNEL || "auto").toLowerCase();

// A named Cloudflare tunnel: a tunnel the user created and routed to a
// hostname they own, as opposed to a quick tunnel's throwaway
// `trycloudflare.com` name. It is the only cloudflared mode that survives a
// restart, so it is also the only one where PUBLIC_URL is authoritative -
// cloudflared never prints the hostname, the DNS route does.
const cloudflareTunnel = envVars.CLOUDFLARE_TUNNEL || "";

let tunnelProvider = "none";
if (cloudflareTunnel) {
  tunnelProvider = "cloudflared-named";
} else if (ngrokDomain) {
  tunnelProvider = "ngrok";
} else if (tunnelPreference === "none") {
  tunnelProvider = "none";
} else if (!hasStaticUrl) {
  if (tunnelPreference === "ngrok" || tunnelPreference === "cloudflared") {
    tunnelProvider = tunnelPreference;
  } else {
    tunnelProvider = "auto";
  }
}
let convexEnvFile = null;

function writeConvexDevEnvFile() {
  const convexUrl = envVars.VITE_CONVEX_URL || envVars.CONVEX_URL;
  const lines = [];
  if (envVars.CONVEX_DEPLOYMENT) {
    lines.push(`CONVEX_DEPLOYMENT=${envVars.CONVEX_DEPLOYMENT}`);
  }
  if (convexUrl) {
    // Convex CLI warns when both CONVEX_URL and VITE_CONVEX_URL are active.
    // The debug UI is Vite-based, and the server falls back to this value.
    lines.push(`VITE_CONVEX_URL=${convexUrl}`);
  }
  if (!lines.length) return null;
  const path = resolve(tmpdir(), `boop-convex-${process.pid}.env.local`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

// --- binary detection ---------------------------------------------------
function hasBinary(name) {
  return new Promise((ok) => {
    const lookup = process.platform === "win32" ? "where" : "which";
    const child = spawn(lookup, [name], { stdio: "ignore" });
    child.on("exit", (code) => ok(code === 0));
    child.on("error", () => ok(false));
  });
}

const nodeCmd = process.env.BOOP_NODE_CMD || "node";

const packageBinPaths = {
  convex: ["convex", "bin", "main.js"],
  tsx: ["tsx", "dist", "cli.mjs"],
  vite: ["vite", "bin", "vite.js"],
};

function localBin(name) {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const binPath = resolve(root, "node_modules", ".bin", `${name}${ext}`);
  if (existsSync(binPath)) return { cmd: binPath, args: [] };

  const packageBin = packageBinPaths[name];
  if (packageBin) {
    const scriptPath = resolve(root, "node_modules", ...packageBin);
    if (existsSync(scriptPath)) return { cmd: nodeCmd, args: [scriptPath] };
  }

  return { cmd: name, args: [] };
}

// --- color-prefixed child runner ----------------------------------------
const C = {
  server: "\x1b[36m",
  convex: "\x1b[35m",
  debug: "\x1b[33m",
  ngrok: "\x1b[32m",
  tunnel: "\x1b[32m",
  upstream: "\x1b[34m",
  banner: "\x1b[1;32m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};
let dashboardUrl = "http://localhost:5173";
let resolveTunnelOutputUrl;
const tunnelOutputUrlReady = new Promise((resolve) => {
  resolveTunnelOutputUrl = resolve;
});

// Vite's http-proxy attaches its own socket error logger that can't be removed
// via configure(). EPIPE on WS reconnects is harmless — filter it at the
// stream level so the logs stay readable.
const NOISE_TRIGGERS = [
  /\[vite\] ws proxy socket error/,
  /\[vite\] ws proxy error/,
  /Error: write EPIPE/,
  /Error: read ECONNRESET/,
  /AggregateError \[ECONNREFUSED\]/,
];
const STACK_LINE = /^\s+at\s/;

function run(name, cmd, args, readyPattern) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  const prefix = `${C[name]}${name.padEnd(6)}${C.reset} │ `;
  let buf = "";
  let suppressing = false;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const feed = (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);

      // ANSI-strip for matching without disturbing the display output.
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      if (name === "debug") {
        const localMatch = plain.match(/Local:\s+(http:\/\/\S+)/);
        if (localMatch) dashboardUrl = localMatch[1].replace(/\/$/, "");
      }
      if (name === "ngrok") {
        const urlMatch =
          plain.match(/\burl=(https:\/\/\S+)/) ||
          plain.match(/Forwarding\s+(https:\/\/\S+)/);
        if (urlMatch) resolveTunnelOutputUrl(urlMatch[1].replace(/\/$/, ""));
      }
      // cloudflared prints the quick-tunnel URL once, inside an ASCII box on
      // stderr. There is no local API to read it back from the way ngrok has,
      // so this line is the only chance to catch it.
      if (name === "tunnel") {
        const urlMatch = plain.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i);
        if (urlMatch) resolveTunnelOutputUrl(urlMatch[1]);
      }

      if (NOISE_TRIGGERS.some((r) => r.test(plain))) {
        suppressing = true;
        continue;
      }
      if (suppressing) {
        if (STACK_LINE.test(plain) || plain.trim() === "") continue;
        suppressing = false;
      }

      if (line.trim()) process.stdout.write(prefix + line + "\n");
      if (readyPattern && readyPattern.test(plain)) resolveReady();
    }
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.ready = ready;
  return child;
}

// --- ngrok URL banner: poll local API after launch ----------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readNgrokUrl() {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels");
    if (res.ok) {
      const data = await res.json();
      return data.tunnels?.find((t) => t.proto === "https")?.public_url ?? null;
    }
  } catch {
    /* not up yet */
  }
  return null;
}

async function waitForNgrokUrl(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const https = await readNgrokUrl();
    if (https) return https;
    await sleep(500);
  }
  return null;
}

function showBanner(url, stable, webhookSyncState) {
  const line = "═".repeat(68);
  const webhook = `${url}/sendblue/webhook`;
  const from = envVars.SENDBLUE_FROM_NUMBER;
  const fromLine = from
    ? `  📱 Text this Sendblue number:  ${from}  (from a DIFFERENT phone)`
    : `  ⚠ SENDBLUE_FROM_NUMBER is not set — outbound sends will fail.\n     Run: npm run sendblue:sync   (pulls it from the Sendblue CLI)`;

  const headline = stable
    ? `your STABLE public URL is live.`
    : tunnelProvider === "cloudflared"
      ? `cloudflared tunnel is live.`
      : `ngrok tunnel is live.`;
  const footerMessage =
    webhookSyncState === "synchronized"
      ? "The inbound webhook above was synchronized with Sendblue automatically."
      : webhookSyncState === "disabled"
        ? "Automatic Sendblue webhook sync is disabled. Run npm run sendblue:webhook -- <url> after changing the public URL."
        : "Sendblue webhook sync failed. Check the webhook log above, then run npm run sendblue:webhook:check.";
  const footer = `\n${C.dim}  ℹ ${footerMessage}${C.reset}\n`;

  console.log(`
${C.banner}${line}
  Boop is ready — ${headline}

  🐶 Debug dashboard (click me):   ${dashboardUrl}
  🌐 Public URL:                   ${url}
  📮 Sendblue webhook (inbound):   ${webhook}
${fromLine}
${line}${C.reset}${footer}`);
}

// --- main ---------------------------------------------------------------
let ngrokInstalled = false;
let cloudflaredInstalled = false;
if (tunnelProvider !== "none") {
  ngrokInstalled = await hasBinary("ngrok");
  cloudflaredInstalled = await hasBinary("cloudflared");
  if (tunnelProvider === "cloudflared-named" && !cloudflaredInstalled) {
    console.log(
      `${C.tunnel}tunnel${C.reset} │ CLOUDFLARE_TUNNEL is set but cloudflared is not installed — running without a tunnel.`,
    );
    tunnelProvider = "none";
  }
  // `auto` resolves here, once it is known what is actually on the machine.
  if (tunnelProvider === "auto") {
    tunnelProvider = ngrokInstalled ? "ngrok" : cloudflaredInstalled ? "cloudflared" : "none";
  } else if (tunnelProvider === "ngrok" && !ngrokInstalled && cloudflaredInstalled) {
    console.log(
      `${C.tunnel}tunnel${C.reset} │ BOOP_TUNNEL=ngrok but ngrok is not installed — falling back to cloudflared.`,
    );
    tunnelProvider = "cloudflared";
  } else if (tunnelProvider === "cloudflared" && !cloudflaredInstalled && ngrokInstalled) {
    console.log(
      `${C.tunnel}tunnel${C.reset} │ BOOP_TUNNEL=cloudflared but cloudflared is not installed — falling back to ngrok.`,
    );
    tunnelProvider = "ngrok";
  }
  if (tunnelProvider === "none") {
    console.log(`
${C.tunnel}! No tunnel available — running without a public URL.${C.reset}
${C.dim}  Install either one:
    brew install cloudflared   (no account needed for a quick tunnel)
    brew install ngrok         then: ngrok config add-authtoken <token>
                               (free token at https://dashboard.ngrok.com)

  Pick one explicitly with BOOP_TUNNEL=cloudflared or BOOP_TUNNEL=ngrok
  in .env.local; the default tries ngrok first, then cloudflared.

  Without a tunnel you can still use the debug dashboard at http://localhost:5173
  — inbound messages won't arrive until your server is reachable.${C.reset}
`);
  }
}

console.log(`\nBoop dev starting on port ${port}. Ctrl-C to stop everything.\n`);

// Background "new-version available?" check. Runs concurrently with the
// child services; output is prefixed with `upstream │ ` by run() so it
// won't collide with startup logs. Silent on the happy path. Not added to
// the `children` array because it exits on its own — we don't want its
// non-zero exit (which shouldn't happen but hedge anyway) to tear down dev.
run("upstream", nodeCmd, ["scripts/check-upstream.mjs"]);

const tsxBin = localBin("tsx");
const serverChild = run(
  "server",
  tsxBin.cmd,
  [...tsxBin.args, "watch", "server/index.ts"],
  /listening on :/,
);
convexEnvFile = writeConvexDevEnvFile();
const convexArgs = ["convex", "dev"];
if (convexEnvFile) convexArgs.push("--env-file", convexEnvFile);
const convexBin = localBin("convex");
const convexChild = run(
  "convex",
  convexBin.cmd,
  [...convexBin.args, ...convexArgs.slice(1)],
  /Convex functions ready/,
);
const viteBin = localBin("vite");
const debugChild = run(
  "debug",
  viteBin.cmd,
  [...viteBin.args, "--config", "debug/vite.config.ts"],
  /Local:\s+http/,
);
const children = [serverChild, convexChild, debugChild];

let tunnelUrlReady = Promise.resolve(null);
if (tunnelProvider === "ngrok") {
  const args = ngrokDomain
    ? ["http", port, `--domain=${ngrokDomain}`, "--log=stdout", "--log-format=term", "--log-level=info"]
    : ["http", port, "--log=stdout", "--log-format=term", "--log-level=info"];
  const ngrokChild = run("ngrok", "ngrok", args);
  children.push(ngrokChild);
  tunnelUrlReady = Promise.race([
    tunnelOutputUrlReady,
    new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
  ]).then((url) => url ?? waitForNgrokUrl().catch(() => null));
} else if (tunnelProvider === "cloudflared-named") {
  // `tunnel run` attaches to a tunnel that already exists and is already
  // routed, so there is no URL to capture: PUBLIC_URL is the hostname the
  // route points at. Readiness is a log line rather than a URL.
  const tunnelChild = run(
    "tunnel",
    "cloudflared",
    ["tunnel", "run", cloudflareTunnel, "--no-autoupdate"],
    /Registered tunnel connection|Connection [0-9a-f-]+ registered/,
  );
  children.push(tunnelChild);
  tunnelUrlReady = Promise.race([
    tunnelChild.ready.then(() => publicUrl),
    new Promise((resolve) => setTimeout(() => resolve(publicUrl), 30000)),
  ]);
} else if (tunnelProvider === "cloudflared") {
  // A quick tunnel: no account, no config, a new hostname every run. The
  // hostname rotating is the reason the Sendblue and Telegram webhooks are
  // re-registered below on every boot rather than only when they look stale.
  const tunnelChild = run("tunnel", "cloudflared", [
    "tunnel",
    "--url",
    `http://localhost:${port}`,
    "--no-autoupdate",
  ]);
  children.push(tunnelChild);
  // Longer than ngrok's window on purpose: cloudflared picks an edge server
  // before it prints anything, which is routinely slower than ngrok's start.
  tunnelUrlReady = Promise.race([
    tunnelOutputUrlReady,
    new Promise((resolve) => setTimeout(() => resolve(null), 30000)),
  ]);
}

// Wait for all the core services to be ready before printing the banner,
// so the URL isn't dangled in front of the user while Convex is still booting.
async function autoRegisterWebhook(publicUrl) {
  if (envVars.SENDBLUE_AUTO_WEBHOOK === "false") return "disabled";
  const webhookUrl = `${publicUrl}/sendblue/webhook`;
  const prefix = `${C.ngrok}webhook${C.reset} │ `;
  const child = spawn(nodeCmd, ["scripts/sendblue-webhook.mjs", webhookUrl], {
    cwd: root,
    env: { ...process.env },
  });
  child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  child.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  return code === 0 ? "synchronized" : "failed";
}

let sendblueWebhookRegistrationUrl = "";
let sendblueWebhookRegistration = Promise.resolve();
function registerSendblueWebhookOnce(publicUrl) {
  if (sendblueWebhookRegistrationUrl === publicUrl) return sendblueWebhookRegistration;
  sendblueWebhookRegistrationUrl = publicUrl;
  sendblueWebhookRegistration = sendblueWebhookRegistration.then(() =>
    autoRegisterWebhook(publicUrl),
  );
  return sendblueWebhookRegistration;
}

async function registerSendblueWhenTunnelAppears() {
  await sleep(2500);
  const start = Date.now();
  while (Date.now() - start < 60000) {
    const publicUrl = await readNgrokUrl();
    if (publicUrl) {
      await registerSendblueWebhookOnce(publicUrl);
      return;
    }
    await sleep(1000);
  }
}

async function autoRegisterTelegramWebhook(publicUrl) {
  if (!envVars.TELEGRAM_BOT_TOKEN) return;
  const prefix = `${C.tunnel}telegram${C.reset} │ `;
  const tsxBin = localBin("tsx");
  const child = spawn(tsxBin.cmd, [...tsxBin.args, "scripts/telegram-webhook.ts", publicUrl], {
    cwd: root,
    env: { ...process.env },
  });
  const feed = (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  await new Promise((r) => child.on("exit", r));
}

async function autoRegisterComposioWebhook(publicUrl) {
  if (envVars.COMPOSIO_AUTO_WEBHOOK === "false") return;
  if (!envVars.COMPOSIO_API_KEY) return;
  const prefix = `${C.ngrok}composio${C.reset} │ `;
  const tsxBin = localBin("tsx");
  const child = spawn(tsxBin.cmd, [...tsxBin.args, "scripts/composio-webhook.ts", publicUrl], {
    cwd: root,
    env: { ...process.env },
  });
  child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  child.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  await new Promise((r) => child.on("exit", r));
}

// Only ngrok: this path polls ngrok's local API, which cloudflared has no
// equivalent of. cloudflared's registration happens once its URL is captured.
if (tunnelProvider === "ngrok" && !ngrokDomain) {
  registerSendblueWhenTunnelAppears().catch(() => {});
}

Promise.all([
  serverChild.ready,
  convexChild.ready,
  debugChild.ready,
  tunnelUrlReady,
])
  .then(async ([, , , tunnelUrl]) => {
    if (tunnelProvider !== "none") {
      if (tunnelUrl) {
        // ngrok's local API is the more current of the two sources when it is
        // available; cloudflared has none, so its captured URL is used as-is.
        const liveUrl =
          tunnelProvider === "ngrok" ? ((await readNgrokUrl()) ?? tunnelUrl) : tunnelUrl;
        // Synchronize both the URL and signing secret. This is required even
        // for a reserved domain because older dashboard-created webhooks may
        // not have Boop's signing secret yet.
        const webhookSyncState = await registerSendblueWebhookOnce(liveUrl);
        // Telegram holds one webhook URL per bot, so this simply overwrites
        // whatever the last run registered - which is exactly what a rotating
        // quick-tunnel hostname needs.
        await autoRegisterTelegramWebhook(liveUrl);
        // Composio webhook subscription is fully programmatic (PATCHable),
        // so we can refresh it on every restart regardless of whether the
        // domain is reserved.
        await autoRegisterComposioWebhook(liveUrl);
        showBanner(liveUrl, Boolean(ngrokDomain) || tunnelProvider === "cloudflared-named", webhookSyncState);
      } else if (tunnelProvider === "cloudflared-named") {
        console.log(
          `${C.tunnel}tunnel${C.reset} │ CLOUDFLARE_TUNNEL=${cloudflareTunnel} is set but PUBLIC_URL is empty — set PUBLIC_URL to the hostname you routed to that tunnel.`,
        );
      } else if (tunnelProvider === "ngrok") {
        console.log(
          `${C.ngrok}ngrok${C.reset} │ could not read tunnel URL from http://127.0.0.1:4040 — check ngrok output above.`,
        );
      } else {
        console.log(
          `${C.tunnel}tunnel${C.reset} │ cloudflared did not print a tunnel URL within 30s — check its output above.`,
        );
      }
    } else if (hasStaticUrl) {
      const webhookSyncState = await registerSendblueWebhookOnce(publicUrl);
      await autoRegisterTelegramWebhook(publicUrl);
      await autoRegisterComposioWebhook(publicUrl);
      showBanner(publicUrl, true, webhookSyncState);
    } else {
      const line = "═".repeat(68);
      console.log(`
${C.banner}${line}
  Boop is running locally.

  🐶 Debug dashboard:   ${dashboardUrl}

  ⚠ No public tunnel configured. iMessage won't work until you expose
    the server. Use the Chat tab in the dashboard to test for now.
${line}${C.reset}
`);
    }
  })
  .catch(() => {});

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (convexEnvFile) {
    try {
      unlinkSync(convexEnvFile);
    } catch {
      /* ignore */
    }
  }
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 500);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const c of children) {
  c.on("exit", (code) => {
    if (!shuttingDown && code !== null && code !== 0) {
      console.error(`\nA child process exited with code ${code}. Shutting down.`);
      shutdown(code);
    }
  });
}
