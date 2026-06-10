import { describe, expect, it } from "vitest";
import { parseIntent, sanitiseTarget, TARGET_MAX } from "../src/server/intent.js";

describe("intent parsing", () => {
  it("accepts the valid enum (case-insensitive, trimmed)", () => {
    expect(parseIntent("feeding")).toBe("feeding");
    expect(parseIntent("  HUNTING ")).toBe("hunting");
    expect(parseIntent("Evading")).toBe("evading");
  });

  it("rejects anything outside the enum", () => {
    expect(parseIntent("attack")).toBeNull();
    expect(parseIntent("")).toBeNull();
    expect(parseIntent(null)).toBeNull();
    expect(parseIntent(42)).toBeNull();
  });
});

describe("target sanitising", () => {
  it("keeps benign short text", () => {
    expect(sanitiseTarget("npc_hunter")).toBe("npc_hunter");
    expect(sanitiseTarget("fruit NE")).toBe("fruit NE");
  });

  it("strips markup / injection characters", () => {
    const s = sanitiseTarget('<script>alert(1)</script>');
    expect(s).not.toContain("<");
    expect(s).not.toContain(">");
    expect(s).not.toContain("(");
  });

  it("keeps natural sentence punctuation", () => {
    const s = sanitiseTarget("I'm boxing it in. Can't reach food yet — will I escape?");
    expect(s).toContain("'");
    expect(s).toContain("?");
    expect(s).toContain(".");
    expect(s).not.toContain("—"); // non-ASCII dash still stripped
  });

  it("caps the length", () => {
    const s = sanitiseTarget("x".repeat(100));
    expect((s ?? "").length).toBeLessThanOrEqual(TARGET_MAX);
  });

  it("masks profanity", () => {
    const s = sanitiseTarget("go to hell you shit");
    expect(s).not.toMatch(/shit/i);
    expect(s).toContain("*");
  });

  it("returns undefined for empty/whitespace/non-string", () => {
    expect(sanitiseTarget("   ")).toBeUndefined();
    expect(sanitiseTarget("")).toBeUndefined();
    expect(sanitiseTarget(123)).toBeUndefined();
  });
});
