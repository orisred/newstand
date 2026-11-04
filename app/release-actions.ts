export type ReleaseStatus =
  "UNANNOUNCED" | "PREORDER" | "READY" | "SHIPPED" | "CANCELLED";

/**
 * The only legal moves. Shared with the UI so it shows exactly the buttons the server
 * accepts. Cancel also needs no order to exist yet, because orders can start at pre-order
 * under PREORDER_OPENS timing. `transitionRelease` checks that against the Deliveries.
 */
export const RELEASE_ACTIONS = {
  announce: { from: ["UNANNOUNCED"], to: "PREORDER" },
  ready: { from: ["PREORDER"], to: "READY" },
  ship: { from: ["READY"], to: "SHIPPED" },
  cancel: { from: ["UNANNOUNCED", "PREORDER"], to: "CANCELLED" },
} as const satisfies Record<
  string,
  { from: readonly ReleaseStatus[]; to: ReleaseStatus }
>;

export type ReleaseAction = keyof typeof RELEASE_ACTIONS;

export function isReleaseAction(value: unknown): value is ReleaseAction {
  return typeof value === "string" && Object.hasOwn(RELEASE_ACTIONS, value);
}

export function actionsFor(status: ReleaseStatus): ReleaseAction[] {
  return (Object.keys(RELEASE_ACTIONS) as ReleaseAction[]).filter((action) =>
    (RELEASE_ACTIONS[action].from as readonly ReleaseStatus[]).includes(status),
  );
}

export const capitalize = (text: string) =>
  text[0].toUpperCase() + text.slice(1);
