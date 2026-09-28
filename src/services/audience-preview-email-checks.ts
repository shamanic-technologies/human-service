// Can we actually REACH the people an audience's free preview shows?
//
// The preview (audience-preview.ts) proves we found real people. This proves we
// can reach them: for the first PREVIEW_EMAIL_CHECK_SAMPLE people of the stored
// sample, run apollo-service's billed reveal (`/enrich` by the person's handle)
// and read the verifier's verdict it returns beside the person. The visitor sees
// "found · valid via apollo" per person, never the address.
//
// One person per call (`checkNextPreviewPerson`), so a consumer calling in a
// loop watches the people resolve one by one, and each call's latency is one
// reveal (~6-7s in prod). Real by construction: a row exists only for a reveal that ran
// and came back; `pending` means not attempted yet.
//
// Cost: apollo-service declares it (apollo-credit for the reveal, BounceVerify
// for the verdict), provision → authorize → execute → actualize, against the
// CALLER's org — the anonymous org on a signed-out visit. human-service declares
// none, same as every other reveal it asks for. Bounded: at most
// PREVIEW_EMAIL_CHECK_SAMPLE reveals per audience, ever — a checked person is
// never re-revealed (the row is the record), and a claim row taken BEFORE the
// spend stops two concurrent callers paying for the same person.
//
// Deliberately NOT a serve: no lead_serves / brand_suppressions row, no
// audience membership. Nobody was contacted, so nobody becomes unservable; the
// reveal apollo-service stores is its own cache for a later serve.

import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiencePreviewEmailChecks, audiences } from "../db/schema.js";
import { readEmailVerification } from "../lib/email-verification.js";
import { apolloPost, type Identity } from "./people-providers.js";
import {
  getRevealablePreview,
  type AudiencePreviewReason,
  type StoredAudiencePreview,
} from "./audience-preview.js";

type AudienceRow = typeof audiences.$inferSelect;
type CheckRow = typeof audiencePreviewEmailChecks.$inferSelect;

// How many sampled people are checked. Each is one Apollo reveal + one
// verification (~12¢ + ~0.4¢ at org price), charged to the caller's org.
// Five is enough to show the race and prove reach without spending a signed-out
// visitor's credit on the whole 20-person sample.
export const PREVIEW_EMAIL_CHECK_SAMPLE = 5;

// A claim older than this is a caller that died mid-reveal (process restart):
// it may be re-taken. apollo-service's own reveal cache makes the re-ask free
// when the first one did land.
export const PREVIEW_EMAIL_CHECK_STALE_MS = 2 * 60 * 1000;

export type PreviewEmailCheckStatus = "pending" | "checking" | "found" | "not_found";

export type PreviewEmailChecksReason =
  | AudiencePreviewReason
  | "empty_sample"
  | "no_reveal_handle";

export interface PreviewEmailCheckPerson {
  index: number;
  firstName: string | null;
  lastNameObfuscated: string | null;
  title: string | null;
  company: string | null;
  status: PreviewEmailCheckStatus;
  finder: string | null;
  verifier: string | null;
  verdict: string | null;
  deliverable: boolean | null;
  maskedEmail: string | null;
  checkedAt: string | null;
}

export interface PreviewEmailChecks {
  audienceId: string;
  status: "ready" | "unavailable";
  reason: PreviewEmailChecksReason | null;
  done: boolean;
  people: PreviewEmailCheckPerson[];
  summary: { checked: number; found: number; deliverable: number };
}

function unavailable(audienceId: string, reason: PreviewEmailChecksReason): PreviewEmailChecks {
  return {
    audienceId,
    status: "unavailable",
    reason,
    done: true,
    people: [],
    summary: { checked: 0, found: 0, deliverable: 0 },
  };
}

// The checked subset of the sample, or a reason there is none.
function checkedSubset(
  preview: StoredAudiencePreview
): { reason: PreviewEmailChecksReason } | { people: StoredAudiencePreview["people"] } {
  if (preview.status === "unavailable") return { reason: preview.reason ?? "not_built_yet" };
  if (preview.people.length === 0) return { reason: "empty_sample" };
  const subset = preview.people.slice(0, PREVIEW_EMAIL_CHECK_SAMPLE);
  if (subset.some((p) => typeof p.providerPersonId !== "string" || !p.providerPersonId)) {
    return { reason: "no_reveal_handle" };
  }
  return { people: subset };
}

function isStaleClaim(row: CheckRow, now: number): boolean {
  return row.status === "checking" && now - row.claimedAt.getTime() > PREVIEW_EMAIL_CHECK_STALE_MS;
}

// "***@acme.com": the domain only. The local part is the address; it is never
// stored and never returned.
function maskEmail(domain: string | null): string | null {
  return domain ? `***@${domain}` : null;
}

function build(
  audienceId: string,
  people: StoredAudiencePreview["people"],
  rows: CheckRow[]
): PreviewEmailChecks {
  const now = Date.now();
  const byIndex = new Map(rows.map((r) => [r.personIndex, r]));
  const out: PreviewEmailCheckPerson[] = people.map((p, index) => {
    const row = byIndex.get(index);
    // A row whose handle differs belongs to a sample that has since been
    // re-taken; it says nothing about the person now at this position.
    const own = row && row.providerPersonId === p.providerPersonId ? row : undefined;
    const status: PreviewEmailCheckStatus =
      !own || isStaleClaim(own, now) ? "pending" : (own.status as PreviewEmailCheckStatus);
    const settled = status === "found" || status === "not_found";
    return {
      index,
      firstName: p.firstName,
      lastNameObfuscated: p.lastNameObfuscated,
      title: p.title,
      company: p.company,
      status,
      finder: settled ? own!.finder : null,
      verifier: settled ? own!.verifier : null,
      verdict: settled ? own!.verdict : null,
      deliverable: settled ? own!.deliverable : null,
      maskedEmail: settled ? maskEmail(own!.emailDomain) : null,
      checkedAt: settled && own!.checkedAt ? own!.checkedAt.toISOString() : null,
    };
  });
  const found = out.filter((p) => p.status === "found");
  return {
    audienceId,
    status: "ready",
    reason: null,
    done: out.every((p) => p.status === "found" || p.status === "not_found"),
    people: out,
    summary: {
      checked: out.filter((p) => p.status === "found" || p.status === "not_found").length,
      found: found.length,
      deliverable: found.filter((p) => p.deliverable === true).length,
    },
  };
}

async function loadRows(audienceId: string): Promise<CheckRow[]> {
  return db
    .select()
    .from(audiencePreviewEmailChecks)
    .where(eq(audiencePreviewEmailChecks.audienceId, audienceId))
    .orderBy(asc(audiencePreviewEmailChecks.personIndex));
}

// Free read: where the check stands. Never spends. (May re-take a stored sample
// that predates reveal handles — the preview call is free.)
export async function getPreviewEmailChecks(
  audience: AudienceRow,
  identity: Identity
): Promise<PreviewEmailChecks> {
  const preview = await getRevealablePreview(audience, identity);
  const subset = checkedSubset(preview);
  if ("reason" in subset) return unavailable(audience.id, subset.reason);
  return build(audience.id, subset.people, await loadRows(audience.id));
}

// Take the claim on one position before any spend. Inserts a `checking` row, or
// takes over a stale claim / a row left by a re-taken sample. Returns false when
// another caller holds it or it is already settled for this person.
async function claim(audienceId: string, index: number, handle: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - PREVIEW_EMAIL_CHECK_STALE_MS);
  const inserted = await db
    .insert(audiencePreviewEmailChecks)
    .values({ audienceId, personIndex: index, providerPersonId: handle, status: "checking" })
    .onConflictDoNothing()
    .returning({ id: audiencePreviewEmailChecks.id });
  if (inserted.length > 0) return true;
  const retaken = await db
    .update(audiencePreviewEmailChecks)
    .set({
      providerPersonId: handle,
      status: "checking",
      finder: null,
      verifier: null,
      verdict: null,
      deliverable: null,
      emailDomain: null,
      claimedAt: new Date(),
      checkedAt: null,
    })
    .where(
      and(
        eq(audiencePreviewEmailChecks.audienceId, audienceId),
        eq(audiencePreviewEmailChecks.personIndex, index),
        or(
          sql`${audiencePreviewEmailChecks.providerPersonId} <> ${handle}`,
          and(
            eq(audiencePreviewEmailChecks.status, "checking"),
            lt(audiencePreviewEmailChecks.claimedAt, staleBefore)
          )
        )
      )
    )
    .returning({ id: audiencePreviewEmailChecks.id });
  return retaken.length > 0;
}

async function release(audienceId: string, index: number): Promise<void> {
  await db
    .delete(audiencePreviewEmailChecks)
    .where(
      and(
        eq(audiencePreviewEmailChecks.audienceId, audienceId),
        eq(audiencePreviewEmailChecks.personIndex, index),
        eq(audiencePreviewEmailChecks.status, "checking")
      )
    );
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  const domain = at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
  return domain.length > 0 ? domain : null;
}

// Run ONE reveal for the next unchecked sampled person, persist the outcome,
// return the whole state. Spends nothing when every sampled person is settled,
// when the sample is unavailable, or when another caller holds the next claim.
export async function checkNextPreviewPerson(
  audience: AudienceRow,
  identity: Identity
): Promise<PreviewEmailChecks> {
  const preview = await getRevealablePreview(audience, identity);
  const subset = checkedSubset(preview);
  if ("reason" in subset) return unavailable(audience.id, subset.reason);

  const current = build(audience.id, subset.people, await loadRows(audience.id));
  const next = current.people.find((p) => p.status === "pending");
  if (!next) return current;

  const handle = subset.people[next.index].providerPersonId as string;
  if (!(await claim(audience.id, next.index, handle))) {
    return build(audience.id, subset.people, await loadRows(audience.id));
  }

  let data: { person?: { email?: string | null } | null; emailVerification?: unknown };
  try {
    // The reveal is charged to the caller's org and attributed to this
    // audience's brand, exactly like a serve-next reveal.
    data = (await apolloPost(
      "/enrich",
      { apolloPersonId: handle },
      {
        ...identity,
        brandIds: [audience.brandId],
        workflowTracking: {
          ...identity.workflowTracking,
          brandIds: [audience.brandId],
          audienceId: audience.id,
        },
      }
    )) as typeof data;
  } catch (err) {
    // Nothing came back: drop the claim so the next call retries this person.
    await release(audience.id, next.index);
    throw err;
  }

  const email = data.person?.email ?? null;
  let verification;
  try {
    verification = readEmailVerification("apollo", data.emailVerification, email);
  } catch (err) {
    await release(audience.id, next.index);
    throw err;
  }
  const v = (data.emailVerification ?? null) as { verifier?: unknown } | null;
  const found = typeof email === "string" && email.trim().length > 0;

  await db
    .update(audiencePreviewEmailChecks)
    .set({
      status: found ? "found" : "not_found",
      finder: "apollo",
      verifier: found && v && typeof v.verifier === "string" ? v.verifier : null,
      verdict: verification?.verdict ?? null,
      deliverable: verification?.deliverable ?? null,
      emailDomain: found ? domainOf(email) : null,
      checkedAt: new Date(),
    })
    .where(
      and(
        eq(audiencePreviewEmailChecks.audienceId, audience.id),
        eq(audiencePreviewEmailChecks.personIndex, next.index)
      )
    );

  return build(audience.id, subset.people, await loadRows(audience.id));
}
