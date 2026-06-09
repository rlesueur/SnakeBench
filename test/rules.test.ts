import { describe, expect, it } from "vitest";
import { RULE_CARDS, MODIFIERS, pickRuleCard, rollModifiers, rollLaws, rollRoundExtras, capRoundExtras, MAX_ROUND_EXTRAS, foodMultiplier } from "../src/rules/cards.js";

describe("rule cards", () => {
  it("every card is well-formed", () => {
    for (const c of RULE_CARDS) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.brief.length).toBeGreaterThan(20);
      expect(["survive", "grow", "kills", "zone", "relay", "bell", "fasting"]).toContain(c.objective);
      expect(["normal", "scarce", "feast"]).toContain(c.foodMod);
    }
  });

  it("picks deterministically from the seed", () => {
    const a = pickRuleCard("snake-r7");
    const b = pickRuleCard("snake-r7");
    expect(a.id).toBe(b.id);
  });

  it("only ever returns a card from the catalogue", () => {
    const ids = new Set(RULE_CARDS.map((c) => c.id));
    for (let i = 0; i < 200; i++) {
      expect(ids.has(pickRuleCard(`r${i}`).id)).toBe(true);
    }
  });

  it("produces variety across rounds", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(pickRuleCard(`round-${i}`).id);
    expect(seen.size).toBeGreaterThan(1);
  });

  it("scales food by modifier", () => {
    expect(foodMultiplier("scarce")).toBeLessThan(1);
    expect(foodMultiplier("normal")).toBe(1);
    expect(foodMultiplier("feast")).toBeGreaterThan(1);
  });
});

describe("rule-card modifiers", () => {
  it("every modifier is well-formed", () => {
    for (const m of MODIFIERS) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.brief.length).toBeGreaterThan(20);
    }
  });

  it("rolls deterministically from the seed", () => {
    const a = rollModifiers("snake-r7").map((m) => m.id);
    const b = rollModifiers("snake-r7").map((m) => m.id);
    expect(a).toEqual(b);
  });

  it("never exceeds two modifiers and never picks conflicting pairs", () => {
    for (let i = 0; i < 500; i++) {
      const mods = rollModifiers(`r${i}`);
      expect(mods.length).toBeLessThanOrEqual(2);
      const ids = mods.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates
      for (const m of mods) {
        for (const other of mods) {
          if (m === other) continue;
          expect(m.conflicts?.includes(other.id)).not.toBe(true);
        }
      }
    }
  });

  it("produces a variety of modifier sets across rounds", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      seen.add(rollModifiers(`v${i}`).map((m) => m.id).sort().join(","));
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it("caps modifiers and laws at MAX_ROUND_EXTRAS combined", () => {
    expect(MAX_ROUND_EXTRAS).toBe(3);
    for (let i = 0; i < 500; i++) {
      const { modifiers, laws } = rollRoundExtras(`cap-${i}`, 80, 80);
      expect(modifiers.length + laws.length).toBeLessThanOrEqual(3);
    }
    const trimmed = capRoundExtras(
      rollModifiers("heavy-mods"),
      rollLaws("heavy-laws", 80, 80),
    );
    expect(trimmed.modifiers.length + trimmed.laws.length).toBeLessThanOrEqual(3);
  });
});
