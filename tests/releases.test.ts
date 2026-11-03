import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../app/db.server";
import {
  actionsFor,
  RELEASE_ACTIONS,
  type ReleaseAction,
  type ReleaseStatus,
} from "../app/release-actions";
import {
  createRelease,
  listReleases,
  PAGE_SIZE,
  parseQuantity,
  parseTitle,
  transitionRelease,
} from "../app/releases.server";
import { getOrCreateShop } from "../app/shop.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
let n = 0;
const newShop = () => getOrCreateShop(db(), `rel${++n}.myshopify.com`);

async function releaseWithStatus(shopId: string, status: ReleaseStatus) {
  const key = `key-${++n}-${status}`;
  await createRelease(db(), shopId, { key, title: "T", quantity: null });
  const id = `${shopId}:${key}`;
  await db().release.update({ where: { id }, data: { status } });
  return id;
}

const ALL: ReleaseStatus[] = [
  "UNANNOUNCED",
  "PREORDER",
  "READY",
  "SHIPPED",
  "CANCELLED",
];

describe("transitionRelease", () => {
  for (const action of Object.keys(RELEASE_ACTIONS) as ReleaseAction[]) {
    for (const from of ALL) {
      const legal = (
        RELEASE_ACTIONS[action].from as readonly string[]
      ).includes(from);
      it(`${action} from ${from} is ${legal ? "allowed" : "refused"}`, async () => {
        const shop = await newShop();
        const id = await releaseWithStatus(shop.id, from);
        const result = await transitionRelease(
          db(),
          shop.id,
          id,
          action,
          "issue",
        );
        const after = await db().release.findUniqueOrThrow({ where: { id } });
        expect(result.ok).toBe(legal);
        expect(after.status).toBe(legal ? RELEASE_ACTIONS[action].to : from);
        expect(actionsFor(from).includes(action)).toBe(legal);
      });
    }
  }

  it("walks the whole path and stamps dates only on announce and ready", async () => {
    const shop = await newShop();
    await createRelease(db(), shop.id, {
      key: "walk-12345678",
      title: "T",
      quantity: 5,
    });
    const id = `${shop.id}:walk-12345678`;
    const read = () => db().release.findUniqueOrThrow({ where: { id } });

    let release = await read();
    expect(release.preorderOpensAt).toBeNull();
    expect(release.cutoffAt).toBeNull();
    expect(release.triggerMode).toBe("MANUAL");

    const t1 = new Date("2027-01-01T10:00:00.000Z");
    const t2 = new Date("2027-02-01T10:00:00.000Z");
    await transitionRelease(db(), shop.id, id, "announce", "issue", t1);
    release = await read();
    expect(release.status).toBe("PREORDER");
    expect(release.preorderOpensAt).toEqual(t1);
    expect(release.cutoffAt).toBeNull();

    await transitionRelease(db(), shop.id, id, "ready", "issue", t2);
    release = await read();
    expect(release.status).toBe("READY");
    expect(release.preorderOpensAt).toEqual(t1);
    expect(release.cutoffAt).toEqual(t2);

    await transitionRelease(db(), shop.id, id, "ship", "issue");
    release = await read();
    expect(release.status).toBe("SHIPPED");
    expect(release.cutoffAt).toEqual(t2);
  });

  it("a double press changes nothing the second time and says so", async () => {
    const shop = await newShop();
    const id = await releaseWithStatus(shop.id, "UNANNOUNCED");
    const t1 = new Date("2027-01-01T10:00:00.000Z");
    const results = await Promise.all([
      transitionRelease(db(), shop.id, id, "announce", "issue", t1),
      transitionRelease(
        db(),
        shop.id,
        id,
        "announce",
        "issue",
        new Date("2027-05-05"),
      ),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok)!;
    expect(refused.message).toBe(
      "Nothing changed: this issue is already in pre-order.",
    );
    const after = await db().release.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe("PREORDER");
    expect(after.preorderOpensAt?.getFullYear()).toBe(2027);
    expect([1, 5]).toContain(after.preorderOpensAt!.getMonth() + 1);
  });

  it("a stale tab pressing a move that is no longer legal changes nothing", async () => {
    const shop = await newShop();
    const id = await releaseWithStatus(shop.id, "READY");
    const result = await transitionRelease(
      db(),
      shop.id,
      id,
      "announce",
      "drop",
    );
    expect(result).toEqual({
      ok: false,
      message:
        "Nothing changed: this drop is ready to ship, so it can't be moved there. Reload to see its latest status.",
    });
  });

  it("never touches another shop's release", async () => {
    const mine = await newShop();
    const theirs = await newShop();
    const id = await releaseWithStatus(theirs.id, "UNANNOUNCED");
    const result = await transitionRelease(
      db(),
      mine.id,
      id,
      "announce",
      "issue",
    );
    expect(result.ok).toBe(false);
    const after = await db().release.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe("UNANNOUNCED");
    expect(after.preorderOpensAt).toBeNull();
  });
});

describe("createRelease", () => {
  it("numbers releases per shop", async () => {
    const a = await newShop();
    const b = await newShop();
    await createRelease(db(), a.id, {
      key: "aaaaaaaa1",
      title: "A1",
      quantity: null,
    });
    await createRelease(db(), a.id, {
      key: "aaaaaaaa2",
      title: "A2",
      quantity: 10,
    });
    await createRelease(db(), b.id, {
      key: "bbbbbbbb1",
      title: "B1",
      quantity: null,
    });
    const { releases } = await listReleases(db(), a.id);
    expect(releases.map((r) => r.number)).toEqual([2, 1]);
    expect(
      (await listReleases(db(), b.id)).releases.map((r) => r.number),
    ).toEqual([1]);
  });

  it("a double-submitted form creates one release without an error", async () => {
    const shop = await newShop();
    const input = { key: "double-submit-1", title: "Once", quantity: null };
    const results = await Promise.all([
      createRelease(db(), shop.id, input),
      createRelease(db(), shop.id, input),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await listReleases(db(), shop.id)).releases).toHaveLength(1);
  });

  it("two different forms at once get different numbers", async () => {
    const shop = await newShop();
    await Promise.all([
      createRelease(db(), shop.id, {
        key: "race-aaaaaaa",
        title: "A",
        quantity: null,
      }),
      createRelease(db(), shop.id, {
        key: "race-bbbbbbb",
        title: "B",
        quantity: null,
      }),
    ]);
    const { releases } = await listReleases(db(), shop.id);
    expect(releases.map((r) => r.number).sort()).toEqual([1, 2]);
  });
});

describe("listReleases", () => {
  it("is bounded to a page and gives a cursor for the next", async () => {
    const shop = await newShop();
    await db().release.createMany({
      data: Array.from({ length: PAGE_SIZE + 3 }, (_, i) => ({
        shopId: shop.id,
        number: i + 1,
        title: `R${i + 1}`,
      })),
    });
    const first = await listReleases(db(), shop.id);
    expect(first.releases).toHaveLength(PAGE_SIZE);
    expect(first.releases[0].number).toBe(PAGE_SIZE + 3);
    expect(first.nextBefore).toBe(4);
    const second = await listReleases(db(), shop.id, first.nextBefore!);
    expect(second.releases.map((r) => r.number)).toEqual([3, 2, 1]);
    expect(second.nextBefore).toBeNull();
  });
});

describe("input parsing", () => {
  it("validates titles and quantities", () => {
    expect(parseTitle("  Issue 3 ")).toBe("Issue 3");
    expect(parseTitle("   ")).toBeNull();
    expect(parseTitle("x".repeat(121))).toBeNull();
    expect(parseTitle(null)).toBeNull();
    expect(parseQuantity("")).toEqual({ quantity: null });
    expect(parseQuantity("500")).toEqual({ quantity: 500 });
    for (const bad of ["0", "-1", "1.5", "abc", "1e9"]) {
      expect(parseQuantity(bad)).toEqual({ error: true });
    }
  });
});
