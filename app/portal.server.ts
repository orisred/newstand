import type { createDb } from "./db.server";
import { recordAddressConfirmation } from "./emails.server";
import { logEvent } from "./logger.server";
import type { Graphql } from "./plan-sync.server";
import { DUE_SUBSCRIPTION } from "./release-runs.server";
import { markCancelled } from "./subscriptions.server";

type Db = ReturnType<typeof createDb>;

/**
 * The customer portal's server side, called by the customer account extension and by the email
 * link page. Everything here acts on one signed-in customer's own subscriptions: the customer
 * comes from the session token (`sub`), never from the request body, and a subscription ID from
 * the extension is only ever looked up together with that customer (`ownSubscription`).
 */

const CHARGEBACK = "CHARGEBACK";

export type Words = { singular: string; plural: string };

/** The words a customer reads. Never hard-code "issue": the shop's own word goes in. */
export function portalCopy({ singular: word, plural: words }: Words) {
  const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  return {
    heading: "Your subscription",
    upcomingHeading: `Upcoming ${words}`,
    noUpcoming: `No ${words} are announced yet. We'll email you when the next one is.`,
    addressNote: `Changes apply to orders created from now on. Any ${word} whose order is already created keeps the address it was created with.`,
    cardNote: `We'll email you a secure link to update your card. Once it's saved, we'll try any payment that failed again.`,
    /** True whether or not a try follows: the job decides, and may decline (see `retryCharge`). */
    resumeAsked: `We've passed this on. If a payment is waiting and can be tried again now, we'll try it shortly. Refresh this page in a minute to see where it stands.`,
    cardSent: `We've emailed you a secure link to update your card.`,
    /** What cancelling does, before the customer decides. */
    cancel(paidLeft: number, onHold: boolean, held: number) {
      const count = `${paidLeft} ${paidLeft === 1 ? word : words}`;
      const lines: string[] = [];
      if (onHold) {
        lines.push(
          `Your subscription is on hold after a payment dispute. Cancelling stops any future charge. The ${words} you've paid for stay on hold until the shop reviews it.`,
        );
      } else if (paidLeft > 0) {
        lines.push(
          `You'll still receive the ${count} you've already paid for. You won't be charged again, and what you've paid isn't refunded.`,
        );
      } else {
        lines.push(
          `You won't be charged again. You've already received every ${word} you paid for.`,
        );
      }
      if (held > 0 && !onHold) {
        lines.push(
          `Any ${word} we couldn't charge you for won't ship if you cancel.`,
        );
      }
      return lines.join(" ");
    },
    /** After cancelling, in the same terms as the note before it. */
    cancelled: (paidLeft: number, onHold: boolean) =>
      onHold
        ? `Your subscription is cancelled and you won't be charged again. The ${words} you've paid for stay on hold until the shop reviews it.`
        : paidLeft > 0
          ? `Your subscription is cancelled. You'll still receive the ${paidLeft} ${paidLeft === 1 ? word : words} you've paid for.`
          : `Your subscription is cancelled. You won't be charged again.`,
    confirmed: `Thanks, your delivery address is confirmed.`,
    /** Shown on the email link page when the subscriber's order for that release is already created. */
    started: cap(
      `${word} orders are already created, so address changes apply to your next ${word}.`,
    ),
    /** When there's nothing left to confirm for it: not theirs, cancelled, or no longer open. */
    closed: `We can't take an address confirmation for this ${word} any more. Sign in to check the address on your subscription.`,
  };
}

// ---- who is asking ---------------------------------------------------------------------

/** The signed-in customer's own subscription in this shop, or null. Ended and redacted ones never match. */
export function ownSubscription(
  db: Db,
  shopDomain: string,
  customerGid: string,
  subscriptionId: string,
) {
  if (!customerGid.startsWith("gid://shopify/Customer/"))
    return Promise.resolve(null);
  return db.subscription.findFirst({
    where: {
      id: subscriptionId,
      customerGid,
      status: { not: "ENDED" },
      shop: { shopDomain },
    },
    select: {
      id: true,
      shopId: true,
      contractGid: true,
      status: true,
      pausedReason: true,
      paymentProblemSince: true,
      releasesRemaining: true,
      firstReleaseNumber: true,
      plan: { select: { displayName: true } },
      shop: {
        select: {
          shopDomain: true,
          releaseWordSingular: true,
          releaseWordPlural: true,
          allowedCountries: true,
        },
      },
    },
  });
}
type Own = NonNullable<Awaited<ReturnType<typeof ownSubscription>>>;

// ---- upcoming releases and address confirmation ------------------------------------------

const STATE_TEXT = {
  hold: "On hold until your payment goes through",
  ordered: "Order created, it's shipping",
  unannounced: "Not announced yet",
  preorder: "In pre-order",
  ready: "Starting to ship",
} as const;

/**
 * The releases this subscriber will receive, and whether each one's address can be confirmed now.
 *
 * "Will receive" is what a run would do: a release with a Delivery on it, or one the subscriber is
 * due for (`DUE_SUBSCRIPTION`, the rule a run assigns by) and has paid for. A subscriber is due for
 * at most as many releases without a Delivery as they have paid releases spare (`releasesRemaining`
 * less their waiting Deliveries), or one more if a charge is what's due. So a cancelled subscriber
 * sees only what they paid for, and a bundle with one release left sees one.
 *
 * A confirmation means something only until the order is created, because the address is read then,
 * and it needs somewhere to be kept: the waiting Delivery, or the pre-order email's row for a
 * Delivery that doesn't exist yet (see `recordAddressConfirmation`).
 */
export async function upcomingFor(
  db: Db,
  rawDb: D1Database,
  subscription: Pick<
    Own,
    "id" | "shopId" | "firstReleaseNumber" | "releasesRemaining" | "status"
  >,
) {
  const candidates = await db.release.findMany({
    where: {
      shopId: subscription.shopId,
      status: { in: ["UNANNOUNCED", "PREORDER", "READY"] },
      number: { gte: subscription.firstReleaseNumber },
    },
    orderBy: { number: "asc" },
    take: 8,
    select: { id: true, title: true, status: true },
  });
  const ids = candidates.map((release) => release.id);
  if (ids.length === 0) return [];
  const [deliveries, sends, pending, due] = await Promise.all([
    db.delivery.findMany({
      where: {
        subscriptionId: subscription.id,
        releaseId: { in: ids },
        status: { not: "CANCELLED" },
      },
      select: { releaseId: true, status: true, addressConfirmedAt: true },
    }),
    db.emailSend.findMany({
      where: {
        id: {
          in: ids.map((id) => `preorderAnnounced:${subscription.id}:${id}`),
        },
      },
      select: { id: true, addressConfirmedAt: true },
    }),
    db.delivery.count({
      where: { subscriptionId: subscription.id, status: "PENDING" },
    }),
    rawDb
      .prepare(
        `SELECT r."id" FROM "Release" r
         JOIN "Subscription" s ON s."id" = ?1 AND s."shopId" = r."shopId"
         JOIN "Plan" p ON p."id" = s."planId"
         WHERE r."id" IN (${ids.map((_, i) => `?${i + 2}`).join(", ")}) AND ${DUE_SUBSCRIPTION}`,
      )
      .bind(subscription.id, ...ids)
      .all<{ id: string }>(),
  ]);
  const dueIds = new Set(due.results.map((row) => row.id));
  // Paid releases not yet spoken for. Only an active subscriber, whose next charge pays for its own
  // release, is due one without a paid release spare.
  const paidSpare = subscription.releasesRemaining - pending;
  let spare = paidSpare > 0 ? paidSpare : subscription.status === "ACTIVE" ? 1 : 0;

  return candidates
    .flatMap((release) => {
      const delivery = deliveries.find((d) => d.releaseId === release.id);
      const send = sends.find(
        (s) => s.id === `preorderAnnounced:${subscription.id}:${release.id}`,
      );
      if (!delivery) {
        if (!dueIds.has(release.id) || spare-- <= 0) return [];
      }
      const ordered =
        delivery?.status === "ORDERED" || delivery?.status === "FULFILLED";
      const waiting = delivery
        ? delivery.status === "PENDING" || delivery.status === "HELD"
        : Boolean(send);
      return [
        {
          id: release.id,
          title: release.title,
          ordered,
          state:
            delivery?.status === "HELD"
              ? STATE_TEXT.hold
              : ordered
                ? STATE_TEXT.ordered
                : release.status === "UNANNOUNCED"
                  ? STATE_TEXT.unannounced
                  : release.status === "PREORDER"
                    ? STATE_TEXT.preorder
                    : STATE_TEXT.ready,
          confirmable: release.status !== "UNANNOUNCED" && waiting,
          confirmed: Boolean(
            delivery?.addressConfirmedAt ?? send?.addressConfirmedAt,
          ),
        },
      ];
    })
    .slice(0, 4);
}

/**
 * Records that the address was confirmed for one release, if that still means something.
 * Returns whether it did. The caller has already decided who is allowed to ask.
 */
export async function confirmAddress(
  db: Db,
  rawDb: D1Database,
  subscription: Pick<
    Own,
    "id" | "shopId" | "firstReleaseNumber" | "releasesRemaining" | "status"
  >,
  releaseId: string,
  now = new Date(),
) {
  const release = (await upcomingFor(db, rawDb, subscription)).find(
    (r) => r.id === releaseId,
  );
  if (!release?.confirmable) return false;
  await recordAddressConfirmation(rawDb, subscription.id, releaseId, now);
  return true;
}

// ---- reading the contract ----------------------------------------------------------------

const ADDRESS_FIELDS = `firstName lastName company address1 address2 city provinceCode zip countryCode phone`;

const CONTRACTS = `#graphql
  query PortalContracts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on SubscriptionContract {
        id
        deliveryMethod {
          ... on SubscriptionDeliveryMethodShipping { address { ${ADDRESS_FIELDS} } }
        }
        customerPaymentMethod {
          instrument { ... on CustomerCreditCard { brand lastDigits } }
        }
      }
    }
  }`;

export type Address = Partial<
  Record<(typeof ADDRESS_KEYS)[number], string | null>
>;
const ADDRESS_KEYS = [
  "firstName",
  "lastName",
  "company",
  "address1",
  "address2",
  "city",
  "provinceCode",
  "zip",
  "countryCode",
  "phone",
] as const;

/** Everything the extension shows. The address and card come live from Shopify and are never stored or logged. */
export async function loadPortal(
  db: Db,
  rawDb: D1Database,
  graphqlFor: () => Promise<Graphql>,
  shopDomain: string,
  customerGid: string,
) {
  if (!customerGid.startsWith("gid://shopify/Customer/")) return null;
  const subscriptions = await db.subscription.findMany({
    where: {
      customerGid,
      status: { not: "ENDED" },
      shop: { shopDomain },
      contractGid: { not: null },
    },
    orderBy: { createdAt: "asc" },
    take: 10,
    select: { id: true },
  });
  const shop = await db.shop.findUnique({
    where: { shopDomain },
    select: { releaseWordSingular: true, releaseWordPlural: true },
  });
  if (!shop) return null;
  const words = {
    singular: shop.releaseWordSingular,
    plural: shop.releaseWordPlural,
  };
  const copy = portalCopy(words);

  const owned = (
    await Promise.all(
      subscriptions.map(({ id }) =>
        ownSubscription(db, shopDomain, customerGid, id),
      ),
    )
  ).filter((s): s is Own => Boolean(s));
  const data = owned.length
    ? await (
        await graphqlFor()
      )(CONTRACTS, { ids: owned.map((s) => s.contractGid) })
    : { nodes: [] };
  type Node = {
    id: string;
    deliveryMethod?: { address?: Address };
    customerPaymentMethod?: {
      instrument?: { brand?: string; lastDigits?: string };
    } | null;
  };
  const nodes = new Map<string, Node>(
    (data.nodes as (Node | null)[])
      .filter((n): n is Node => Boolean(n))
      .map((n) => [n.id, n]),
  );

  return {
    words,
    copy: {
      heading: copy.heading,
      upcomingHeading: copy.upcomingHeading,
      noUpcoming: copy.noUpcoming,
      addressNote: copy.addressNote,
      cardNote: copy.cardNote,
    },
    subscriptions: await Promise.all(
      owned.map(async (s) => {
        const node = nodes.get(s.contractGid!);
        const held = await db.delivery.count({
          where: { subscriptionId: s.id, status: "HELD" },
        });
        const onHold = s.pausedReason === CHARGEBACK;
        const card = node?.customerPaymentMethod?.instrument;
        return {
          id: s.id,
          plan: s.plan.displayName,
          status: s.status,
          onHold,
          cardProblem: s.paymentProblemSince !== null && !onHold,
          paidLeft: s.releasesRemaining,
          address: node?.deliveryMethod?.address ?? null,
          card: card?.lastDigits
            ? `${card.brand ?? "Card"} ending ${card.lastDigits}`
            : null,
          upcoming: await upcomingFor(db, rawDb, s),
          cancelNote: copy.cancel(s.releasesRemaining, onHold, held),
        };
      }),
    ),
  };
}

// ---- changing things -------------------------------------------------------------------

export class PortalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const DRAFT_OPEN = `#graphql
  mutation PortalDraftOpen($contract: ID!) {
    subscriptionContractUpdate(contractId: $contract) {
      draft { id }
      userErrors { message }
    }
  }`;
const DRAFT_ADDRESS = `#graphql
  mutation PortalDraftAddress($draft: ID!, $input: SubscriptionDraftInput!) {
    subscriptionDraftUpdate(draftId: $draft, input: $input) {
      userErrors { message }
    }
  }`;
const DRAFT_COMMIT = `#graphql
  mutation PortalDraftCommit($draft: ID!) {
    subscriptionDraftCommit(draftId: $draft) {
      contract { id }
      userErrors { message }
    }
  }`;

const REQUIRED: (typeof ADDRESS_KEYS)[number][] = [
  "firstName",
  "lastName",
  "address1",
  "city",
  "zip",
  "countryCode",
];

/** Trims, bounds and checks what the customer typed. The country must be one the shop ships to. */
export function cleanAddress(
  input: unknown,
  allowedCountries: unknown,
): Address {
  const raw = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;
  const address: Address = {};
  for (const key of ADDRESS_KEYS) {
    const value =
      typeof raw[key] === "string"
        ? (raw[key] as string).trim().slice(0, 255)
        : "";
    if (value) address[key] = value;
  }
  if (REQUIRED.some((key) => !address[key])) {
    throw new PortalError(
      "address_incomplete",
      "Please fill in every required field.",
    );
  }
  address.countryCode = address.countryCode!.toUpperCase();
  const allowed = Array.isArray(allowedCountries) ? allowedCountries : [];
  if (!allowed.includes(address.countryCode)) {
    throw new PortalError(
      "country_not_allowed",
      "We can't ship to that country.",
    );
  }
  return address;
}

export async function changeAddress(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  subscription: Own,
  input: unknown,
  now = new Date(),
) {
  if (subscription.status === "CANCELLED") {
    throw new PortalError("cancelled", "This subscription is cancelled.");
  }
  const address = cleanAddress(input, subscription.shop.allowedCountries);
  const { subscriptionContractUpdate: opened } = await graphql(DRAFT_OPEN, {
    contract: subscription.contractGid,
  });
  if (opened.userErrors.length > 0)
    throw new PortalError(
      "shopify",
      "We couldn't open your subscription to change it.",
    );
  const { subscriptionDraftUpdate: updated } = await graphql(DRAFT_ADDRESS, {
    draft: opened.draft.id,
    input: { deliveryMethod: { shipping: { address } } },
  });
  if (updated.userErrors.length > 0) {
    throw new PortalError("address_refused", updated.userErrors[0].message);
  }
  const { subscriptionDraftCommit: committed } = await graphql(DRAFT_COMMIT, {
    draft: opened.draft.id,
  });
  if (committed.userErrors.length > 0)
    throw new PortalError("shopify", "We couldn't save your address.");
  // The customer has just looked at it, so it counts as confirmed for what's waiting.
  for (const release of await upcomingFor(db, rawDb, subscription)) {
    if (release.confirmable)
      await recordAddressConfirmation(rawDb, subscription.id, release.id, now);
  }
  logEvent("info", "portal.address_changed", {
    subscriptionId: subscription.id,
  });
}

const PAYMENT_METHOD = `#graphql
  query PortalPaymentMethod($id: ID!) {
    subscriptionContract(id: $id) { customerPaymentMethod { id } }
  }`;
const SEND_UPDATE = `#graphql
  mutation PortalCardEmail($id: ID!) {
    customerPaymentMethodSendUpdateEmail(customerPaymentMethodId: $id) {
      userErrors { message }
    }
  }`;

/**
 * Has Shopify email the customer its own secure page to enter a new card, so the app never sees
 * one. (`customerPaymentMethodGetUpdateUrl` would skip the email, but it only supports Shop Pay.)
 * Saving the card fires `customer_payment_methods/update`, which recovers a failed payment.
 */
export async function sendCardUpdateEmail(graphql: Graphql, subscription: Own) {
  const { subscriptionContract } = await graphql(PAYMENT_METHOD, {
    id: subscription.contractGid,
  });
  const id = subscriptionContract?.customerPaymentMethod?.id;
  if (!id)
    throw new PortalError(
      "no_card",
      "There's no card on this subscription to update.",
    );
  const { customerPaymentMethodSendUpdateEmail: result } = await graphql(
    SEND_UPDATE,
    { id },
  );
  if (result.userErrors.length > 0)
    throw new PortalError("shopify", "We couldn't send the card link.");
}

const CANCEL = `#graphql
  mutation PortalCancel($id: ID!) {
    subscriptionContractCancel(subscriptionContractId: $id) {
      contract { id status }
      userErrors { message }
    }
  }`;

/**
 * Cancels the contract and records it. Paid releases still ship and nothing is refunded
 * (DECISIONS.md): `markCancelled` closes only what's held or unpaid. Refused while a charge is
 * in flight, because its result would land after the customer was told they won't be charged.
 */
export async function cancelSubscription(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  subscription: Own,
  now = new Date(),
) {
  if (subscription.status === "CANCELLED") return;
  if (
    await db.billingAttempt.count({
      where: { subscriptionId: subscription.id, result: "PENDING" },
    })
  ) {
    throw new PortalError(
      "charge_in_progress",
      "A payment is being processed. Please try again in a few minutes.",
    );
  }
  const { subscriptionContractCancel: result } = await graphql(CANCEL, {
    id: subscription.contractGid,
  });
  if (result.userErrors.length > 0 && result.contract?.status !== "CANCELLED") {
    throw new PortalError("shopify", "We couldn't cancel your subscription.");
  }
  await markCancelled(rawDb, subscription.id, now);
  logEvent("info", "portal.cancelled", { subscriptionId: subscription.id });
}
