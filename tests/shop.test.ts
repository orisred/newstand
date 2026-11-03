import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { COUNTRY_CODES } from "../app/countries";
import { createDb } from "../app/db.server";
import {
  EMAIL_KEYS,
  getOrCreateShop,
  isEmailEnabled,
  parseSettings,
  saveSettings,
} from "../app/shop.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const valid = {
  releaseWordSingular: "drop",
  releaseWordPlural: "drops",
  allowedCountries: "us, ca",
  orderTiming: "PREORDER_OPENS",
  email_welcome: "on",
};

describe("getOrCreateShop", () => {
  it("creates the row once with defaults and returns the same one after", async () => {
    const db = createDb(env.DB);
    const [a, b] = await Promise.all([
      getOrCreateShop(db, "create.myshopify.com"),
      getOrCreateShop(createDb(env.DB), "create.myshopify.com"),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.releaseWordSingular).toBe("issue");
    expect(a.orderTiming).toBe("READY_TO_SHIP");
    expect((await getOrCreateShop(db, "create.myshopify.com")).id).toBe(a.id);
    expect(
      await db.shop.count({ where: { shopDomain: "create.myshopify.com" } }),
    ).toBe(1);
  });

  it("does not write when the shop exists", async () => {
    const db = createDb(env.DB);
    const first = await getOrCreateShop(db, "nowrite.myshopify.com");
    const before = await db.shop.findUniqueOrThrow({ where: { id: first.id } });
    await getOrCreateShop(db, "nowrite.myshopify.com");
    const after = await db.shop.findUniqueOrThrow({ where: { id: first.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});

describe("isEmailEnabled", () => {
  it("treats a missing key as on and only an explicit false as off", () => {
    expect(isEmailEnabled({}, "welcome")).toBe(true);
    expect(isEmailEnabled({ welcome: false }, "welcome")).toBe(false);
    expect(isEmailEnabled({ welcome: false }, "failedPayment")).toBe(true);
    expect(isEmailEnabled({ welcome: true }, "welcome")).toBe(true);
    expect(isEmailEnabled(null, "welcome")).toBe(true);
    expect(isEmailEnabled([], "welcome")).toBe(true);
    expect(isEmailEnabled("garbage", "welcome")).toBe(true);
  });
});

describe("parseSettings", () => {
  it("accepts valid input, normalizing countries and writing every email key", () => {
    const result = parseSettings(form(valid));
    expect(result).toEqual({
      ok: true,
      values: {
        releaseWordSingular: "drop",
        releaseWordPlural: "drops",
        allowedCountries: ["US", "CA"],
        orderTiming: "PREORDER_OPENS",
        emailsEnabled: {
          welcome: true,
          preorderAnnounced: false,
          upcomingCharge: false,
          failedPayment: false,
          lastReleaseShipping: false,
        },
      },
    });
    expect(Object.keys(result.ok ? result.values.emailsEnabled : {})).toEqual([
      ...EMAIL_KEYS,
    ]);
  });

  it("rejects bad words, countries and timing", () => {
    const cases: [Record<string, string>, string][] = [
      [{ ...valid, releaseWordSingular: "  " }, "releaseWordSingular"],
      [{ ...valid, releaseWordPlural: "x".repeat(31) }, "releaseWordPlural"],
      [{ ...valid, releaseWordSingular: "<b>" }, "releaseWordSingular"],
      [{ ...valid, allowedCountries: "" }, "allowedCountries"],
      [{ ...valid, allowedCountries: "US, USA" }, "allowedCountries"],
      [{ ...valid, allowedCountries: "U1" }, "allowedCountries"],
      [{ ...valid, allowedCountries: "US, ZZ" }, "allowedCountries"],
      [{ ...valid, allowedCountries: "AN" }, "allowedCountries"],
      [{ ...valid, allowedCountries: "XX" }, "allowedCountries"],
      [{ ...valid, orderTiming: "NEVER" }, "orderTiming"],
    ];
    for (const [fields, field] of cases) {
      const result = parseSettings(form(fields));
      expect(result.ok).toBe(false);
      expect(Object.keys(result.ok ? {} : result.errors)).toContain(field);
    }
  });
});

describe("country codes", () => {
  it("accepts real ones, lower case, and Shopify's own XK", () => {
    const result = parseSettings(
      form({ ...valid, allowedCountries: "us gb, XK de" }),
    );
    expect(result.ok && result.values.allowedCountries).toEqual([
      "US",
      "GB",
      "XK",
      "DE",
    ]);
  });

  it("holds each code once, with no placeholder codes", () => {
    expect(COUNTRY_CODES.size).toBe(243);
    expect(COUNTRY_CODES.has("ZZ")).toBe(false);
    expect(COUNTRY_CODES.has("AN")).toBe(false);
  });
});

describe("saveSettings", () => {
  it("changes only the given shop", async () => {
    const db = createDb(env.DB);
    const mine = await getOrCreateShop(db, "mine.myshopify.com");
    const theirs = await getOrCreateShop(db, "theirs.myshopify.com");
    const parsed = parseSettings(form(valid));
    if (!parsed.ok) throw new Error("invalid");
    await saveSettings(db, mine.id, parsed.values);

    const savedMine = await getOrCreateShop(db, "mine.myshopify.com");
    expect(savedMine.releaseWordSingular).toBe("drop");
    expect(savedMine.allowedCountries).toEqual(["US", "CA"]);
    expect(savedMine.orderTiming).toBe("PREORDER_OPENS");
    expect(isEmailEnabled(savedMine.emailsEnabled, "upcomingCharge")).toBe(
      false,
    );
    expect(isEmailEnabled(savedMine.emailsEnabled, "welcome")).toBe(true);
    const savedTheirs = await getOrCreateShop(db, "theirs.myshopify.com");
    expect(savedTheirs).toEqual(theirs);
  });
});
