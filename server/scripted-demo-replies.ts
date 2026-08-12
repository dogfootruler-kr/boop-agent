import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { broadcast } from "./broadcast.js";
import { currentPage, launchLocalBrowser } from "./browser/launcher.js";
import { redactPhoneNumbers } from "./privacy.js";
import { sendToConversation, startTypingForConversation } from "./channels/outbound.js";

const DEMO_MODE_SETTING_KEY = "debug_demo_mode";
const WATER_BOTTLE_PROMPT = "what was that water bottle brand my mom texted me about";
const LINKEDIN_LOGIN_URL = "https://www.linkedin.com/login/en-us/";

export function matchesWaterBottleDemoPrompt(content: string): boolean {
  return normalizeDemoPrompt(content) === WATER_BOTTLE_PROMPT;
}

export function matchesLinkedInDemoPrompt(content: string): boolean {
  const prompt = normalizeDemoPrompt(content);
  return (
    /^(?:(?:can|could|would) you |please )?check (?:my )?linkedin(?: messages)?(?: using (?:the )?browser)?$/.test(
      prompt,
    ) ||
    /^(?:(?:can|could|would) you |please )?use (?:the )?browser to check (?:my )?linkedin(?: messages)?$/.test(
      prompt,
    )
  );
}

function normalizeDemoPrompt(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/g, "");
}

function randomDemoTurnId(): string {
  return `demo_turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function openLinkedInLoginForDemo(): Promise<void> {
  await launchLocalBrowser({ forceVisible: true });
  const page = await currentPage();
  await page.goto("about:blank");
  await page.context().addCookies([
    {
      name: "lang",
      value: "v=2&lang=en-us",
      domain: ".linkedin.com",
      path: "/",
      secure: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(LINKEDIN_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
}

async function demoModeEnabled(): Promise<boolean> {
  try {
    const value = await convex.query(api.settings.get, { key: DEMO_MODE_SETTING_KEY });
    return value === "true";
  } catch (err) {
    console.error("[demo-script] failed to read demo mode setting", err);
    return false;
  }
}

type ScriptedDemoReplyOpts = {
  conversationId: string;
  content: string;
  turnTag: string;
};

export async function maybeHandleScriptedDemoReply(
  opts: ScriptedDemoReplyOpts,
): Promise<boolean> {
  const demo = matchesWaterBottleDemoPrompt(opts.content)
    ? "water-bottle"
    : matchesLinkedInDemoPrompt(opts.content)
      ? "linkedin-login"
      : null;
  if (!demo) return false;
  if (!(await demoModeEnabled())) return false;

  const turnId = randomDemoTurnId();
  const log = (message: string) => console.log(`[turn ${opts.turnTag}] [demo-script] ${message}`);

  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: "user",
    content: opts.content,
    turnId,
  });
  broadcast("user_message", {
    conversationId: opts.conversationId,
    content: opts.content,
  });

  const sendStep = async (content: string): Promise<void> => {
    const text = redactPhoneNumbers(content.trim());
    if (!text) return;
    await sendToConversation(opts.conversationId, text);
    await convex.mutation(api.messages.send, {
      conversationId: opts.conversationId,
      role: "assistant",
      content: text,
      turnId,
    });
    broadcast("assistant_message", {
      conversationId: opts.conversationId,
      content: text,
    });
    log(`→ ${JSON.stringify(text)}`);
  };

  if (demo === "water-bottle") {
    log("matched water bottle demo prompt");
    startTypingForConversation(opts.conversationId)();
    await wait(150);
    await sendStep("Searching your messages for the thread from your mom...");

    startTypingForConversation(opts.conversationId)();
    await wait(1800);
    await sendStep("It was the LARQ bottle.");
    return true;
  }

  log("matched LinkedIn browser demo prompt");
  startTypingForConversation(opts.conversationId)();
  await wait(250);
  await sendStep("I'll go check it.");

  startTypingForConversation(opts.conversationId)();
  try {
    await Promise.all([
      openLinkedInLoginForDemo(),
      wait(1400),
    ]);
    log("opened visible LinkedIn login page");
  } catch (err) {
    console.error(`[turn ${opts.turnTag}] [demo-script] failed to open LinkedIn login`, err);
  }
  await sendStep(
    "I tried using the browser, but I need you to log in. Please log in and then, when you're done, let me know.",
  );

  return true;
}
