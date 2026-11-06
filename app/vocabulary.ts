// Safe to import from route components: no server code.

/**
 * The words customers read for what they bought, chosen per shop like the release word. A preset rather
 * than free text, so the copy stays grammatical: each one fixes the noun, the person and the verb.
 */
export const VOCABULARIES = ["SUBSCRIPTIONS", "MEMBERSHIPS"] as const;
export type Vocabulary = (typeof VOCABULARIES)[number];

export type Terms = {
  /** "your subscription" */
  noun: string;
  /** For a selling plan group's option name and headings. */
  Noun: string;
  /** "As a subscriber" */
  member: string;
  /** "you can subscribe again" */
  subscribe: string;
  /** "Thanks for subscribing to Yearly" */
  subscribingTo: string;
  /** "because you subscribe to Cake Zine" */
  belongTo: string;
  /** "the email address you subscribed with" */
  subscribedWith: string;
};

const TERMS: Record<Vocabulary, Terms> = {
  SUBSCRIPTIONS: {
    noun: "subscription",
    Noun: "Subscription",
    member: "subscriber",
    subscribe: "subscribe",
    subscribingTo: "subscribing to",
    belongTo: "subscribe to",
    subscribedWith: "subscribed with",
  },
  MEMBERSHIPS: {
    noun: "membership",
    Noun: "Membership",
    member: "member",
    subscribe: "join",
    subscribingTo: "joining",
    belongTo: "are a member of",
    subscribedWith: "joined with",
  },
};

/** Anything unknown, or a shop from before the setting, reads "subscription". */
export const termsOf = (vocabulary?: string | null): Terms =>
  TERMS[(VOCABULARIES as readonly string[]).includes(vocabulary ?? "") ? (vocabulary as Vocabulary) : "SUBSCRIPTIONS"];
