import { describe, expect, it } from "vitest";
import { buildExecutionSystemPrompt } from "../server/execution-agent.js";

// Placeholder number only - this is a public repo.
const RECIPIENT = ["+", "1", "555", "000", "0101"].join("");

describe("execution agent channel line", () => {
  it("names WhatsApp on a whatsapp: conversation and never mentions iMessage", () => {
    const prompt = buildExecutionSystemPrompt(`whatsapp:${RECIPIENT}`);

    expect(prompt).toContain("The user is messaging Boop on WhatsApp right now.");
    expect(prompt).not.toContain("iMessage");
  });

  it("names iMessage on an sms: conversation and never mentions WhatsApp", () => {
    const prompt = buildExecutionSystemPrompt(`sms:${RECIPIENT}`);

    expect(prompt).toContain("The user is messaging Boop on iMessage right now.");
    expect(prompt).not.toContain("WhatsApp");
  });

  it("falls back to a channel-neutral line when no conversation is attached, e.g. automation runs", () => {
    const prompt = buildExecutionSystemPrompt(undefined);

    expect(prompt).toContain("The user reaches Boop through one of its messaging channels.");
    expect(prompt).not.toContain("iMessage");
    expect(prompt).not.toContain("WhatsApp");
  });

  it("carries no per-channel formatting guidance", () => {
    const prompt = buildExecutionSystemPrompt(`sms:${RECIPIENT}`);

    const lower = prompt.toLowerCase();
    expect(lower).not.toContain("markdown");
    expect(lower).not.toContain("asterisk");
    expect(lower).not.toContain("bold");
    expect(lower).not.toContain("code block");
    expect(lower).not.toMatch(/\bchunk/);
    expect(lower).not.toContain("500 words");
  });
});
