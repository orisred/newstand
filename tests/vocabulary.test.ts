import { describe, expect, it } from "vitest";
import { parsePlan } from "../app/plans.server";
import { parseSettings } from "../app/import.server";
import { termsOf, VOCABULARIES } from "../app/vocabulary";

describe("termsOf", () => {
  it("reads Subscriptions for an unknown or missing vocabulary", () => {
    for (const unknown of [undefined, null, "", "NOPE"]) expect(termsOf(unknown)).toBe(termsOf("SUBSCRIPTIONS"));
  });

  it("gives Subscriptions the words the admin had before", () => {
    const t = termsOf("SUBSCRIPTIONS");
    expect([t.Plans, t.plan, t.Members, t.member, t.Noun, t.nouns]).toEqual([
      "Plans", "plan", "Subscribers", "subscriber", "Subscription", "subscriptions",
    ]);
    expect(t.nameExamples("issues")).toBe('"Yearly subscription" or "2 issues paid upfront"');
    expect(t.includesLabel).toBe("What it includes (optional)");
    expect(t.perks).toBe("a tier's perks");
  });

  it("gives Memberships tiers and members", () => {
    const t = termsOf("MEMBERSHIPS");
    expect([t.Plans, t.plan, t.Members, t.member, t.Noun, t.nouns]).toEqual([
      "Tiers", "tier", "Members", "member", "Membership", "memberships",
    ]);
    expect(t.nameExamples("issues")).toBe('"Reader Membership" or "Insider Membership"');
    expect(t.includesLabel).toBe("Tier perks (optional)");
  });

  it("keeps each capitalised form the capital of its lower-case one, and names no plan or subscriber in Memberships", () => {
    for (const vocabulary of VOCABULARIES) {
      const t = termsOf(vocabulary) as Record<string, unknown>;
      for (const [lower, upper] of [["plan", "Plan"], ["plans", "Plans"], ["member", "Member"], ["members", "Members"], ["noun", "Noun"], ["nouns", "Nouns"]]) {
        expect(upper && (t[upper] as string).toLowerCase()).toBe(t[lower]);
        expect((t[upper] as string)[0]).toBe((t[upper] as string)[0].toUpperCase());
      }
    }
    const words = Object.values(termsOf("MEMBERSHIPS")).filter((v) => typeof v === "string").join(" ").toLowerCase();
    expect(words).not.toMatch(/\bplans?\b|subscri/);
  });
});

describe("admin messages in the shop's words", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };

  it("names the tier in the plan form's errors", () => {
    const fields = { billingMode: "PER_RELEASE", giftable: "on", startRule: "" };
    const errors = (vocabulary?: string) => {
      const parsed = parsePlan(form(fields), undefined, termsOf(vocabulary));
      return parsed.ok ? {} : parsed.errors;
    };
    expect(errors().giftable).toContain("per-release plan");
    expect(errors("MEMBERSHIPS").giftable).toContain("per-release tier");
    expect(errors("MEMBERSHIPS").startRule).toContain("new members");
  });

  it("names the tier in the import's error", () => {
    const input = { plans: {}, issues: "", giftKeys: "", statusKnown: true };
    const read = (vocabulary?: string) => {
      const parsed = parseSettings(input, termsOf(vocabulary));
      return parsed.ok ? [] : parsed.errors;
    };
    expect(read()).toContain("Say which order lines mean at least one plan.");
    expect(read("MEMBERSHIPS")).toContain("Say which order lines mean at least one tier.");
  });
});
