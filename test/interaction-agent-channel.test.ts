import { describe, expect, it } from "vitest";
import { buildInteractionSystemPrompt } from "../server/interaction-agent.js";

// Placeholder number only - this is a public repo.
const RECIPIENT = ["+", "1", "555", "000", "0101"].join("");

describe("interaction agent channel line", () => {
  it("names WhatsApp on a whatsapp: conversation and never mentions iMessage", () => {
    const prompt = buildInteractionSystemPrompt(`whatsapp:${RECIPIENT}`, []);

    expect(prompt).toContain("The user is messaging you on WhatsApp right now.");
    expect(prompt).not.toContain("iMessage");
  });

  it("names iMessage on an sms: conversation and never mentions WhatsApp", () => {
    const prompt = buildInteractionSystemPrompt(`sms:${RECIPIENT}`, []);

    expect(prompt).toContain("The user is messaging you on iMessage right now.");
    expect(prompt).not.toContain("WhatsApp");
  });

  it("falls back to a channel-neutral line for a conversation with no channel prefix", () => {
    const prompt = buildInteractionSystemPrompt(`chat:${RECIPIENT}`, []);

    expect(prompt).toContain("The user is messaging you through Boop's debug chat console right now.");
    expect(prompt).not.toContain("iMessage");
    expect(prompt).not.toContain("WhatsApp");
  });

  it("carries no per-channel formatting guidance", () => {
    const prompt = buildInteractionSystemPrompt(`sms:${RECIPIENT}`, []);

    const lower = prompt.toLowerCase();
    expect(lower).not.toContain("markdown");
    expect(lower).not.toContain("asterisk");
    expect(lower).not.toContain("bold");
    expect(lower).not.toContain("code block");
    expect(lower).not.toMatch(/\bchunk/);
    expect(lower).not.toContain("2900");
    expect(lower).not.toMatch(/65,?000/);
  });

  it("still substitutes the integrations list alongside the channel line", () => {
    const prompt = buildInteractionSystemPrompt(`whatsapp:${RECIPIENT}`, ["gmail", "slack"]);

    expect(prompt).toContain("Available integrations for spawn_agent: gmail, slack");
  });
});
