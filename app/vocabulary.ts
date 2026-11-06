// Safe to import from route components: no server code.
import { useMatches } from "react-router";

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
  /** Plural of `noun`, and capitalised: "subscriptions", "Subscriptions". */
  nouns: string;
  Nouns: string;
  /** The person: "Subscriber", "subscribers", "Subscribers". */
  Member: string;
  members: string;
  Members: string;
  /** What the merchant sells, in the admin: "plan" or "tier", with its plural and capitalised forms. */
  plan: string;
  Plan: string;
  plans: string;
  Plans: string;
  /** The plan form's examples of "Name customers see", given the release word's plural. */
  nameExamples: (releases: string) => string;
  /** The plan form's label for the perk text, and how its hint names perks. */
  includesLabel: string;
  perks: string;
  /** "Already subscribed in this app" */
  subscribed: string;
  /** "The product customers subscribe on" */
  subscribeOn: string;
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
    nouns: "subscriptions",
    Nouns: "Subscriptions",
    member: "subscriber",
    Member: "Subscriber",
    members: "subscribers",
    Members: "Subscribers",
    plan: "plan",
    Plan: "Plan",
    plans: "plans",
    Plans: "Plans",
    subscribe: "subscribe",
    subscribed: "subscribed",
    subscribeOn: "subscribe on",
    nameExamples: (releases) => `"Yearly subscription" or "2 ${releases} paid upfront"`,
    includesLabel: "What it includes (optional)",
    perks: "a tier's perks",
    subscribingTo: "subscribing to",
    belongTo: "subscribe to",
    subscribedWith: "subscribed with",
  },
  MEMBERSHIPS: {
    noun: "membership",
    Noun: "Membership",
    nouns: "memberships",
    Nouns: "Memberships",
    member: "member",
    Member: "Member",
    members: "members",
    Members: "Members",
    plan: "tier",
    Plan: "Tier",
    plans: "tiers",
    Plans: "Tiers",
    subscribe: "join",
    subscribed: "a member",
    subscribeOn: "join through",
    nameExamples: () => `"Reader Membership" or "Insider Membership"`,
    includesLabel: "Tier perks (optional)",
    perks: "the perks of this tier",
    subscribingTo: "joining",
    belongTo: "are a member of",
    subscribedWith: "joined with",
  },
};

/** Anything unknown, or a shop from before the setting, reads "subscription". */
export const termsOf = (vocabulary?: string | null): Terms =>
  TERMS[(VOCABULARIES as readonly string[]).includes(vocabulary ?? "") ? (vocabulary as Vocabulary) : "SUBSCRIPTIONS"];

/**
 * The words for the admin pages. Every `app.*` loader returns the shop's `vocabulary`, so the nav and
 * the page read it from route data already loaded, with no query of their own.
 */
export function useTerms(): Terms {
  const vocabulary = useMatches()
    .map((match) => (match.data as { vocabulary?: string } | undefined)?.vocabulary)
    .find(Boolean);
  return termsOf(vocabulary);
}
