import { describe, expect, it } from "vitest";
import { formatForTelegram } from "../server/channels/telegram.js";

/** The single part of a reply short enough not to be split. */
function one(text: string): string {
  const parts = formatForTelegram(text);
  expect(parts).toHaveLength(1);
  return parts[0];
}

describe("formatForTelegram", () => {
  it("translates bold and italic into Telegram's HTML subset", () => {
    expect(one("**bold** and *italic* and _also italic_")).toBe(
      "<b>bold</b> and <i>italic</i> and <i>also italic</i>",
    );
  });

  it("renders a heading as bold, since Telegram has no headings", () => {
    expect(one("## Summary")).toBe("<b>Summary</b>");
  });

  it("translates strikethrough and combined bold-italic", () => {
    expect(one("~~gone~~ ***both***")).toBe("<s>gone</s> <b><i>both</i></b>");
  });

  it("escapes HTML in prose so agent output cannot inject markup", () => {
    expect(one("use <script> & <b>tags</b>")).toBe(
      "use &lt;script&gt; &amp; &lt;b&gt;tags&lt;/b&gt;",
    );
  });

  it("keeps a fenced code block and escapes its contents", () => {
    expect(one("```ts\nif (a < b) return;\n```")).toBe(
      '<pre><code class="language-ts">if (a &lt; b) return;</code></pre>',
    );
  });

  it("drops no language tag when the fence carries none", () => {
    expect(one("```\nplain\n```")).toBe("<pre>plain</pre>");
  });

  it("does not read emphasis markers inside a code block", () => {
    expect(one("```\na = b * c * d\n```")).toBe("<pre>a = b * c * d</pre>");
  });

  it("does not read emphasis markers inside an inline code span", () => {
    expect(one("run `a * b * c` now")).toBe("run <code>a * b * c</code> now");
  });

  it("leaves a bare number in prose alone next to a code span", () => {
    // Regression: a placeholder delimited by spaces rather than control
    // characters turned "in 3 minutes" into a stray code span.
    expect(one("wait `x` then 0 or 3 minutes")).toBe(
      "wait <code>x</code> then 0 or 3 minutes",
    );
  });

  it("turns a markdown link into an anchor", () => {
    expect(one("see [docs](https://example.com/a)")).toBe(
      'see <a href="https://example.com/a">docs</a>',
    );
  });

  it("leaves a bullet list's asterisks alone", () => {
    expect(one("* one\n* two")).toBe("* one\n* two");
  });

  it("returns one part for a reply within the length limit", () => {
    expect(formatForTelegram("short")).toEqual(["short"]);
  });

  it("splits an over-long reply on line boundaries", () => {
    const line = "x".repeat(200);
    const parts = formatForTelegram(Array.from({ length: 60 }, () => line).join("\n"));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4000);
      // A split that cut a line in half would leave a part whose last line is
      // shorter than the uniform 200 characters every line here has.
      for (const l of part.split("\n")) expect(l).toBe(line);
    }
  });

  it("closes and reopens a <pre> block that straddles a split", () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i} ${"y".repeat(190)}`).join("\n");
    const parts = formatForTelegram("```\n" + body + "\n```");
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const opens = (part.match(/<pre[\s>]/g) ?? []).length;
      const closes = (part.match(/<\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});
