/** What every email needs to know about the shop. The words are the merchant's own: never hard-code "issue". */
export type ShopCopy = {
  name: string;
  /** The storefront, such as https://shop.example.com */
  url: string;
  singular: string;
  plural: string;
  /** For dates. An IANA name; UTC if the shop has none yet. */
  timezone: string | null;
  /** The shop's business address, for the footer. Not a customer's. */
  address: string | null;
};

export type EmailKind =
  | "welcome"
  | "preorderAnnounced"
  | "upcomingCharge"
  | "failedPayment"
  | "lastReleaseShipping"
  | "priceChange";

export type EmailData =
  | { kind: "welcome"; plan: string }
  | {
      kind: "preorderAnnounced";
      release: string;
      /** Paused subscribers are asked for a card instead of an address. */
      paused: boolean;
      /** Orders are created when the pre-order opens, so there's no address to confirm. */
      ordersNow: boolean;
      addressUrl: string;
      cardUrl: string;
    }
  | {
      kind: "upcomingCharge";
      plan: string;
      amount: string;
      /** The portal, where the customer turns off auto-renew or cancels. */
      portalUrl: string;
      /** A date, a release that triggers the charge, or a renewal held for the last paid release. */
      when:
        | { on: Date; releases: number }
        | { release: string }
        | { held: Date };
    }
  | {
      kind: "failedPayment";
      plan: string;
      retryOn: Date | null;
      cardUrl: string;
    }
  | { kind: "lastReleaseShipping"; plan: string; release: string }
  | {
      kind: "priceChange";
      plan: string;
      oldAmount: string;
      newAmount: string;
      effectiveAt: Date;
      portalUrl: string;
    };

export type Rendered = { subject: string; text: string; html: string };

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ").trim();

export function formatMoney(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );
}

function formatDate(date: Date, timezone: string | null) {
  const options = { dateStyle: "long" } as const;
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: timezone ?? "UTC",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
  }
}

type Body = {
  subject: string;
  paragraphs: string[];
  button?: { label: string; url: string };
};

function compose(shop: ShopCopy, data: EmailData): Body {
  const word = shop.singular;
  const words = shop.plural;
  const date = (value: Date) => formatDate(value, shop.timezone);
  const cancel = `You can turn off auto-renew or cancel any time from your account. The ${words} you've already paid for still ship.`;
  const manage = (url: string) => ({ label: "Turn off auto-renew or cancel", url });

  switch (data.kind) {
    case "welcome":
      return {
        subject: `Welcome to ${shop.name}`,
        paragraphs: [
          `Thanks for subscribing to ${data.plan}.`,
          `Each ${word} ships on its own order, created when that ${word} starts shipping, so you'll get a separate shipping email from ${shop.name} for every ${word}. The order you just paid for only records your payment: it doesn't ship a ${word}.`,
          `If your first ${word} is already out, it ships now on its own order.`,
        ],
      };
    case "preorderAnnounced": {
      const lead = `${data.release} is now in pre-order. As a subscriber, you'll get it as soon as it starts shipping.`;
      if (data.paused) {
        return {
          subject: `${data.release} is up for pre-order`,
          paragraphs: [
            lead,
            `Your subscription is paused because we couldn't charge your card. Update your card to keep receiving your ${words}.`,
          ],
          button: { label: "Update your card", url: data.cardUrl },
        };
      }
      if (data.ordersNow) {
        return {
          subject: `${data.release} is up for pre-order`,
          paragraphs: [
            lead,
            `We're creating your order now, using the delivery address on your subscription.`,
          ],
        };
      }
      return {
        subject: `${data.release} is up for pre-order`,
        paragraphs: [
          lead,
          `We create your order then, using the delivery address on your subscription at that moment. Please check it's right.`,
        ],
        button: {
          label: "Confirm or update your delivery address",
          url: data.addressUrl,
        },
      };
    }
    case "upcomingCharge": {
      const { when, plan, amount } = data;
      if ("on" in when) {
        return {
          subject: `Your ${data.plan} renews on ${date(when.on)}`,
          paragraphs: [
            `On ${date(when.on)}, we'll charge ${amount} plus any tax to your card on file to renew ${plan} for another ${when.releases} ${when.releases === 1 ? word : words}. Auto-renew is on.`,
            cancel,
          ],
          button: manage(data.portalUrl),
        };
      }
      if ("release" in when) {
        return {
          subject: `You'll be charged when ${when.release} starts shipping`,
          paragraphs: [
            `${when.release} is in pre-order. When it starts shipping, we'll charge ${amount} plus any tax to your card on file for ${plan} and create your order. Auto-renew is on.`,
            cancel,
          ],
          button: manage(data.portalUrl),
        };
      }
      return {
        subject: `Your renewal is waiting for your last ${word}`,
        paragraphs: [
          `Your ${plan} term ended on ${date(when.held)}, but your last paid ${word} hasn't shipped yet. We'll renew and charge ${amount} plus any tax to your card on file when it starts shipping. There's nothing you need to do.`,
          cancel,
        ],
        button: manage(data.portalUrl),
      };
    }
    case "failedPayment":
      return {
        subject: "We couldn't charge your card",
        paragraphs: [
          `We tried to charge your card for ${data.plan} and it didn't go through.`,
          data.retryOn
            ? `We'll try again on ${date(data.retryOn)}. To avoid a gap, you can update your card now.`
            : `Your subscription is paused until your payment goes through. Update your card and we'll pick things up again.`,
        ],
        button: { label: "Update your card", url: data.cardUrl },
      };
    case "lastReleaseShipping":
      return {
        subject: `Your last ${word} is on its way`,
        paragraphs: [
          `${data.release} is the last ${word} included in ${data.plan}, and it's starting to ship now. Your subscription won't renew.`,
          `To keep receiving ${words}, you can subscribe again any time at ${shop.url}.`,
        ],
      };
    case "priceChange":
      return {
        subject: `Price change for ${data.plan}`,
        paragraphs: [
          `From ${date(data.effectiveAt)}, the price of ${data.plan} goes from ${data.oldAmount} to ${data.newAmount}, each plus any tax.`,
          `It applies to your first charge on or after ${date(data.effectiveAt)}; nothing changes before then. If you'd rather not continue, you can cancel before then from your account. The ${words} you've already paid for still ship.`,
        ],
        button: manage(data.portalUrl),
      };
  }
}

/** The email as plain text and simple HTML. Every value is escaped, and nothing is a template of the merchant's. */
export function renderEmail(shop: ShopCopy, data: EmailData): Rendered {
  const { subject, paragraphs, button } = compose(shop, data);
  const footer = [
    `You're receiving this because you subscribe to ${shop.name}.`,
    shop.address,
  ].filter((line): line is string => Boolean(line));

  const text = [
    ...paragraphs,
    ...(button ? [`${button.label}: ${button.url}`] : []),
    footer.join("\n"),
  ].join("\n\n");

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#202223;max-width:560px;margin:0 auto;padding:24px">
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")}
${
  button
    ? `<p><a href="${escapeHtml(button.url)}" style="display:inline-block;background:#202223;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px">${escapeHtml(button.label)}</a></p>
<p style="font-size:14px;color:#6d7175">If the button doesn't work, copy this link: ${escapeHtml(button.url)}</p>`
    : ""
}
<hr style="border:0;border-top:1px solid #e1e3e5;margin:24px 0">
<p style="font-size:13px;color:#6d7175">${footer.map(escapeHtml).join("<br>")}</p>
</body></html>`;

  return { subject: oneLine(subject), text, html };
}
