// WHO A PIPE CAN REACH — the contact channel(s) a serving pipe writes on.
//
// A serve made FOR a pipe (lead-service knows the outreach channel it serves) states
// `reachableBy`: the contact method(s) the pipe needs, ALL required. A person without
// them is never served for that pipe, never revealed, never marked served: the pipe
// that can reach them still gets them (owner 2026-10-12, one mechanism for every
// channel and provider). Omitted = the serve is byte-identical to before.
//
// Same vocabulary as crm-service's `reachableBy` (LOCKED there, PR #109):
// "phone" | "email" | a list of both.

import { z } from "zod";
import type { Person } from "../services/people-providers.js";

export const REACH_CHANNELS = ["phone", "email"] as const;
export type Reach = (typeof REACH_CHANNELS)[number];

export const ReachableBySchema = z.union([
  z.enum(REACH_CHANNELS),
  z.array(z.enum(REACH_CHANNELS)).min(1).max(2),
]);
export type ReachableBy = z.infer<typeof ReachableBySchema>;

/** One channel or a list -> a sorted, de-duplicated list. Absent -> []. */
export function normalizeReach(value: ReachableBy | undefined | null): Reach[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list)].sort() as Reach[];
}

// What a person served by each provider can carry. apollo / apify reveal an email and
// nothing else (no phone on their Person); crm-service holds phones and emails and
// filters on both itself (pushed down, so it burns nobody it skips).
export const PROVIDER_REACH: Readonly<Record<"apollo" | "apify" | "crm", readonly Reach[]>> = {
  apollo: ["email"],
  apify: ["email"],
  crm: ["email", "phone"],
};

/** True when every required channel is one the provider's people can carry. */
export function providerCanReach(provider: keyof typeof PROVIDER_REACH, reach: readonly Reach[]): boolean {
  const can = PROVIDER_REACH[provider];
  return reach.every((r) => can.includes(r));
}

/** True when the person carries every required channel. */
export function personReaches(person: Person, reach: readonly Reach[]): boolean {
  return reach.every((r) =>
    r === "email"
      ? typeof person.email === "string" && person.email.trim().length > 0
      : typeof person.phone === "string" && person.phone.trim().length > 0
  );
}
