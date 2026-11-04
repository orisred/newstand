import type { Job } from "./jobs/runner.server";

// A leaf module, so billing, sign-ups and releases can start these jobs and write these events
// without importing the code that sends them.

export const EMAIL_JOB = "email.run";
export const FLOW_JOB = "flow.run";
export const MEMBER_TAG_JOB = "member.tag";

export const STARTED_EVENT = "subscription.started";
export const PAUSED_EVENT = "subscription.paused";
export const CANCELLED_EVENT = "subscription.cancelled";
export const LAST_RELEASE_EVENT = "subscription.last_release_shipped";

/** `key` is the hour for the tick's job, so a DEAD one never blocks the next; anything else for an immediate one. */
export const emailRunJob = (
  shop: string,
  key: string,
  progress: Record<string, string | number | boolean> = {},
): Job => ({ type: EMAIL_JOB, id: `${EMAIL_JOB}:${shop}:${key}`, shop, data: progress });

export const flowJob = (shop: string, key: string): Job => ({
  type: FLOW_JOB,
  id: `${FLOW_JOB}:${shop}:${key}`,
  shop,
});

export const memberTagJob = (
  shop: string,
  key: string,
  progress: Record<string, string> = {},
): Job => ({ type: MEMBER_TAG_JOB, id: `${MEMBER_TAG_JOB}:${shop}:${key}`, shop, data: progress });
