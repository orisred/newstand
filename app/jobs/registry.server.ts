import type { DueWorkFinder, JobHandler } from "./runner.server";

// Steps 7 to 10 add their job types and finders here.
export const jobHandlers: Record<string, JobHandler> = {};
export const dueWorkFinders: DueWorkFinder[] = [];
