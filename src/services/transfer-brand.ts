import { sql } from "../db/index.js";

/**
 * Brand transfer engine behind `POST /internal/transfer-brand` (the fleet
 * contract brand-service orchestrates). Moves EVERY row human-service holds for
 * `sourceBrandId` under `sourceOrgId` to `targetOrgId`, rewriting the brand id
 * to `targetBrandId` when given — in ONE transaction, so a failure leaves the
 * source org exactly as it was.
 *
 * Idempotent by construction: every step selects rows that are still in the
 * source position, so a second call finds nothing and moves nothing. A call
 * that first ran WITHOUT `targetBrandId` and is re-run WITH it completes the
 * brand rewrite on the rows it had already moved (scoped to the target org —
 * a brand id is shared across orgs, so another org's rows are never touched).
 *
 * Tables and how each one is tied to the brand:
 *  - brand-keyed (org_id + brand_id): `audiences`, `lead_serves`,
 *    `brand_suppressions`, `suppression_recoveries`, `suppression_backfills`,
 *    `audience_portfolios` (a launch the target already holds for the same
 *    offer wins: one portfolio per (org, brand, offer)),
 *    `source_campaign_states` (the target's own applied state per (offer, origin)
 *    wins), `source_campaign_audience_holds`, `audience_profile_holds`,
 *    `lists` (brand_id nullable; brand-less lists are org-wide, left alone).
 *  - keyed through an audience of the brand: `audience_members`,
 *    `audience_teaser_buffer`, `audience_teaser_screenings`,
 *    `audience_screened_out`, `audience_candidates`.
 *  - keyed through a list of the brand: `list_members`.
 *  - `human_methodologies` (solo-brand rows only, `brand_ids = [brand]`) and
 *    the `humans` row each one belongs to (1:1).
 *  - `people` — the canonical person is ORG-scoped, not brand-scoped, and one
 *    person can sit in audiences of several brands of the same org. A person
 *    referenced ONLY by the transferred brand moves; a person the source org
 *    still needs for another brand is COPIED into the target org and the
 *    transferred memberships are re-pointed at the copy. Either way the target
 *    org's audiences reference only target-org people, and the source org keeps
 *    what its other brands use.
 *
 * Unique-key collisions with rows the target org already holds (only possible
 * if the target org already had history for the target brand) are MERGED, never
 * duplicated: suppressions keep the widest served window, ledgers keep the
 * target row, people collapse onto the target's same-email person. An audience
 * name collision is NOT merged (two audiences are two evidence trails) — the
 * transaction fails loud (Postgres 23505) and nothing moves.
 *
 * No money moves here: human-service declares no cost.
 */

export interface TransferBrandInput {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
}

export interface TransferBrandResult {
  updatedTables: { tableName: string; count: number }[];
}

// postgres.js types a transaction as `Omit<Sql, ...>`, which drops the call
// signature; the transaction handle is callable at runtime exactly like `sql`.
type Tx = typeof sql;

// Order is the order the report lists them in.
const TABLES = [
  "human_methodologies",
  "humans",
  "audiences",
  "audience_members",
  "audience_teaser_buffer",
  "audience_teaser_screenings",
  "audience_screened_out",
  "audience_candidates",
  "people",
  "lead_serves",
  "brand_suppressions",
  "suppression_recoveries",
  "suppression_backfills",
  "audience_portfolios",
  "source_campaign_states",
  "source_campaign_audience_holds",
  "audience_profile_holds",
  "lists",
  "list_members",
] as const;
type TableName = (typeof TABLES)[number];

export async function transferBrand(
  input: TransferBrandInput
): Promise<TransferBrandResult> {
  const { sourceBrandId, sourceOrgId, targetOrgId } = input;
  const targetBrandId = input.targetBrandId ?? sourceBrandId;

  if (sourceOrgId === targetOrgId && targetBrandId === sourceBrandId) {
    return { updatedTables: [] };
  }

  const counts = new Map<TableName, number>();
  const add = (t: TableName, n: number) =>
    counts.set(t, (counts.get(t) ?? 0) + n);

  await sql.begin(async (transaction) => {
    const tx = transaction as unknown as Tx;
    // (fromOrg, fromBrand) pairs still holding this brand's rows. The second
    // pair completes a brand rewrite on rows an earlier call already moved.
    const origins: [string, string][] = [[sourceOrgId, sourceBrandId]];
    if (targetBrandId !== sourceBrandId) {
      origins.push([targetOrgId, sourceBrandId]);
    }

    for (const [fromOrg, fromBrand] of origins) {
      await moveMethodologies(tx, fromOrg, fromBrand, targetOrgId, targetBrandId, add);
      add("audiences", await moveBrandKeyed(tx, "audiences", fromOrg, fromBrand, targetOrgId, targetBrandId));
      add("lead_serves", await moveBrandKeyed(tx, "lead_serves", fromOrg, fromBrand, targetOrgId, targetBrandId));
      add("brand_suppressions", await moveSuppressions(tx, fromOrg, fromBrand, targetOrgId, targetBrandId));
      add("suppression_recoveries", await moveLedger(tx, "suppression_recoveries", fromOrg, fromBrand, targetOrgId, targetBrandId));
      add("suppression_backfills", await moveLedger(tx, "suppression_backfills", fromOrg, fromBrand, targetOrgId, targetBrandId));
      add("audience_portfolios", await movePortfolios(tx, fromOrg, fromBrand, targetOrgId, targetBrandId));
      add("source_campaign_states", await moveSourceCampaignStates(tx, fromOrg, fromBrand, targetOrgId, targetBrandId));
      add("source_campaign_audience_holds", await moveSourceCampaignHolds(tx, fromOrg, fromBrand, targetOrgId, targetBrandId));
      add("audience_profile_holds", await moveProfileHolds(tx, fromOrg, fromBrand, targetOrgId, targetBrandId));
      if (await tableExists(tx, "lists")) {
        add("lists", await moveBrandKeyed(tx, "lists", fromOrg, fromBrand, targetOrgId, targetBrandId));
      }
    }

    // Children follow their parent: any row still under the source org whose
    // audience / list now lives in the target org under the target brand.
    for (const child of [
      "audience_teaser_buffer",
      "audience_teaser_screenings",
      "audience_screened_out",
      "audience_candidates",
    ] as const) {
      add(child, await moveAudienceChildren(tx, child, sourceOrgId, targetOrgId, targetBrandId));
    }
    await movePeopleAndMembers(tx, sourceOrgId, targetOrgId, targetBrandId, add);

    if (await tableExists(tx, "list_members")) {
      const moved = await tx`
        UPDATE list_members lm SET org_id = ${targetOrgId}
        FROM lists l
        WHERE lm.list_id = l.id
          AND lm.org_id = ${sourceOrgId}
          AND l.org_id = ${targetOrgId}
          AND l.brand_id = ${targetBrandId}
        RETURNING lm.id`;
      add("list_members", moved.length);
    }
  });

  const updatedTables = TABLES.filter((t) => (counts.get(t) ?? 0) > 0).map(
    (t) => ({ tableName: t, count: counts.get(t)! })
  );
  console.log(
    `[human-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId} sourceOrgId=${sourceOrgId} targetOrgId=${targetOrgId} — ${JSON.stringify(updatedTables)}`
  );
  return { updatedTables };
}

async function tableExists(tx: Tx, name: string): Promise<boolean> {
  const [row] = await tx`SELECT to_regclass(${"public." + name}) IS NOT NULL AS ok`;
  return row.ok === true;
}

async function moveBrandKeyed(
  tx: Tx,
  table: "audiences" | "lead_serves" | "lists",
  fromOrg: string,
  fromBrand: string,
  toOrg: string,
  toBrand: string
): Promise<number> {
  const rows =
    table === "audiences"
      ? await tx`UPDATE audiences SET org_id = ${toOrg}, brand_id = ${toBrand}, updated_at = now()
                 WHERE org_id = ${fromOrg} AND brand_id = ${fromBrand} RETURNING id`
      : table === "lists"
        ? await tx`UPDATE lists SET org_id = ${toOrg}, brand_id = ${toBrand}, updated_at = now()
                   WHERE org_id = ${fromOrg} AND brand_id = ${fromBrand} RETURNING id`
        : await tx`UPDATE lead_serves SET org_id = ${toOrg}, brand_id = ${toBrand}
                   WHERE org_id = ${fromOrg} AND brand_id = ${fromBrand} RETURNING id`;
  return rows.length;
}

async function moveSuppressions(
  tx: Tx,
  fromOrg: string,
  fromBrand: string,
  toOrg: string,
  toBrand: string
): Promise<number> {
  // Merge into a same-person row the target already holds: widest window wins.
  const merged = await tx`
    UPDATE brand_suppressions t SET
      first_served_at = LEAST(t.first_served_at, s.first_served_at),
      last_served_at = GREATEST(t.last_served_at, s.last_served_at),
      linkedin_url_norm = COALESCE(t.linkedin_url_norm, s.linkedin_url_norm),
      provider_person_id = COALESCE(t.provider_person_id, s.provider_person_id),
      last_provider = CASE WHEN s.last_served_at > t.last_served_at THEN s.last_provider ELSE t.last_provider END
    FROM brand_suppressions s
    WHERE s.org_id = ${fromOrg} AND s.brand_id = ${fromBrand}
      AND t.org_id = ${toOrg} AND t.brand_id = ${toBrand}
      AND t.email_norm = s.email_norm AND t.id <> s.id
    RETURNING s.id`;
  if (merged.length > 0) {
    const ids = merged.map((r) => r.id as string);
    await tx`DELETE FROM brand_suppressions WHERE id IN ${tx(ids)}`;
  }
  const moved = await tx`
    UPDATE brand_suppressions SET org_id = ${toOrg}, brand_id = ${toBrand}
    WHERE org_id = ${fromOrg} AND brand_id = ${fromBrand} RETURNING id`;
  return merged.length + moved.length;
}

async function moveLedger(
  tx: Tx,
  table: "suppression_recoveries" | "suppression_backfills",
  fromOrg: string,
  fromBrand: string,
  toOrg: string,
  toBrand: string
): Promise<number> {
  // A ledger entry the target already holds for the same (reason, person) is
  // the same repair recorded twice — keep the target's.
  const dropped =
    table === "suppression_recoveries"
      ? await tx`DELETE FROM suppression_recoveries s USING suppression_recoveries t
                 WHERE s.org_id = ${fromOrg} AND s.brand_id = ${fromBrand}
                   AND t.org_id = ${toOrg} AND t.brand_id = ${toBrand}
                   AND t.reason = s.reason AND t.email_norm = s.email_norm AND t.id <> s.id
                 RETURNING s.id`
      : await tx`DELETE FROM suppression_backfills s USING suppression_backfills t
                 WHERE s.org_id = ${fromOrg} AND s.brand_id = ${fromBrand}
                   AND t.org_id = ${toOrg} AND t.brand_id = ${toBrand}
                   AND t.reason = s.reason AND t.email_norm = s.email_norm AND t.id <> s.id
                 RETURNING s.id`;
  const moved =
    table === "suppression_recoveries"
      ? await tx`UPDATE suppression_recoveries SET org_id = ${toOrg}, brand_id = ${toBrand}
                 WHERE org_id = ${fromOrg} AND brand_id = ${fromBrand} RETURNING id`
      : await tx`UPDATE suppression_backfills SET org_id = ${toOrg}, brand_id = ${toBrand}
                 WHERE org_id = ${fromOrg} AND brand_id = ${fromBrand} RETURNING id`;
  return dropped.length + moved.length;
}

async function movePortfolios(
  tx: Tx,
  fromOrg: string,
  fromBrand: string,
  toOrg: string,
  toBrand: string
): Promise<number> {
  // One launch per (org, brand, offer): the target's own launch is kept.
  const dropped = await tx`DELETE FROM audience_portfolios s USING audience_portfolios t
                           WHERE s.org_id = ${fromOrg} AND s.brand_id = ${fromBrand}
                             AND t.org_id = ${toOrg} AND t.brand_id = ${toBrand}
                             AND t.offer_id = s.offer_id AND t.id <> s.id
                           RETURNING s.id`;
  const moved = await tx`UPDATE audience_portfolios SET org_id = ${toOrg}, brand_id = ${toBrand}, updated_at = now()
                         WHERE org_id = ${fromOrg} AND brand_id = ${fromBrand} RETURNING id`;
  return dropped.length + moved.length;
}

async function moveSourceCampaignStates(
  tx: Tx,
  fromOrg: string,
  fromBrand: string,
  toOrg: string,
  toBrand: string
): Promise<number> {
  // One applied state per (org, brand, offer, origin): the target's own is kept.
  const dropped = await tx`DELETE FROM source_campaign_states s USING source_campaign_states t
                           WHERE s.org_id = ${fromOrg} AND s.brand_id = ${fromBrand}
                             AND t.org_id = ${toOrg} AND t.brand_id = ${toBrand}
                             AND t.offer_id = s.offer_id AND t.origin_slug = s.origin_slug AND t.id <> s.id
                           RETURNING s.id`;
  const moved = await tx`UPDATE source_campaign_states SET org_id = ${toOrg}, brand_id = ${toBrand}, updated_at = now()
                         WHERE org_id = ${fromOrg} AND brand_id = ${fromBrand} RETURNING id`;
  return dropped.length + moved.length;
}

async function moveProfileHolds(
  tx: Tx,
  fromOrg: string,
  fromBrand: string,
  toOrg: string,
  toBrand: string
): Promise<number> {
  const moved = await tx`UPDATE audience_profile_holds SET org_id = ${toOrg}, brand_id = ${toBrand}
                         WHERE org_id = ${fromOrg} AND brand_id = ${fromBrand} RETURNING id`;
  return moved.length;
}

async function moveSourceCampaignHolds(
  tx: Tx,
  fromOrg: string,
  fromBrand: string,
  toOrg: string,
  toBrand: string
): Promise<number> {
  const moved = await tx`UPDATE source_campaign_audience_holds SET org_id = ${toOrg}, brand_id = ${toBrand}
                         WHERE org_id = ${fromOrg} AND brand_id = ${fromBrand} RETURNING id`;
  return moved.length;
}

async function moveAudienceChildren(
  tx: Tx,
  table:
    | "audience_teaser_buffer"
    | "audience_teaser_screenings"
    | "audience_screened_out"
    | "audience_candidates",
  sourceOrgId: string,
  toOrg: string,
  toBrand: string
): Promise<number> {
  const rows =
    table === "audience_teaser_buffer"
      ? await tx`UPDATE audience_teaser_buffer c SET org_id = ${toOrg} FROM audiences a
                 WHERE c.audience_id = a.id AND c.org_id = ${sourceOrgId}
                   AND a.org_id = ${toOrg} AND a.brand_id = ${toBrand} RETURNING c.id`
      : table === "audience_teaser_screenings"
        ? await tx`UPDATE audience_teaser_screenings c SET org_id = ${toOrg} FROM audiences a
                   WHERE c.audience_id = a.id AND c.org_id = ${sourceOrgId}
                     AND a.org_id = ${toOrg} AND a.brand_id = ${toBrand} RETURNING c.id`
        : table === "audience_screened_out"
          ? await tx`UPDATE audience_screened_out c SET org_id = ${toOrg} FROM audiences a
                     WHERE c.audience_id = a.id AND c.org_id = ${sourceOrgId}
                       AND a.org_id = ${toOrg} AND a.brand_id = ${toBrand} RETURNING c.id`
          : await tx`UPDATE audience_candidates c SET org_id = ${toOrg} FROM audiences a
                     WHERE c.audience_id = a.id AND c.org_id = ${sourceOrgId}
                       AND a.org_id = ${toOrg} AND a.brand_id = ${toBrand} RETURNING c.id`;
  return rows.length;
}

async function movePeopleAndMembers(
  tx: Tx,
  sourceOrgId: string,
  toOrg: string,
  toBrand: string,
  add: (t: TableName, n: number) => void
): Promise<void> {
  // Every source-org person a transferred membership points at, with the
  // target-org person it must end up as: the target's same-email person when
  // one exists, else a fresh id (moved in place when the source org does not
  // need it any more, copied when another of its brands still does).
  await tx`
    CREATE TEMP TABLE transfer_person_map ON COMMIT DROP AS
    SELECT p.id AS old_id,
           COALESCE(t.id, CASE WHEN shared THEN gen_random_uuid() ELSE p.id END) AS new_id,
           (t.id IS NOT NULL) AS matched,
           shared
    FROM people p
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM audience_members m2 JOIN audiences a2 ON a2.id = m2.audience_id
        WHERE m2.person_id = p.id AND a2.org_id = ${sourceOrgId}
      ) AS shared
    ) s
    LEFT JOIN people t ON t.org_id = ${toOrg} AND t.email_norm = p.email_norm
    WHERE p.org_id = ${sourceOrgId}
      AND p.id IN (
        SELECT m.person_id FROM audience_members m JOIN audiences a ON a.id = m.audience_id
        WHERE m.org_id = ${sourceOrgId} AND a.org_id = ${toOrg} AND a.brand_id = ${toBrand}
      )`;

  const movedPeople = await tx`
    UPDATE people p SET org_id = ${toOrg}
    FROM transfer_person_map m
    WHERE p.id = m.old_id AND NOT m.matched AND NOT m.shared
    RETURNING p.id`;
  const copiedPeople = await tx`
    INSERT INTO people (id, org_id, email_norm, linkedin_url_norm, apollo_person_id,
      apify_person_id, first_name, last_name, full_name, company_domain, company_name,
      title, first_seen_at, last_seen_at)
    SELECT m.new_id, ${toOrg}, p.email_norm, p.linkedin_url_norm, p.apollo_person_id,
      p.apify_person_id, p.first_name, p.last_name, p.full_name, p.company_domain,
      p.company_name, p.title, p.first_seen_at, p.last_seen_at
    FROM transfer_person_map m JOIN people p ON p.id = m.old_id
    WHERE NOT m.matched AND m.shared
    RETURNING id`;

  const members = await tx`
    UPDATE audience_members am SET org_id = ${toOrg}, person_id = m.new_id
    FROM audiences a, transfer_person_map m
    WHERE am.audience_id = a.id AND am.person_id = m.old_id
      AND am.org_id = ${sourceOrgId} AND a.org_id = ${toOrg} AND a.brand_id = ${toBrand}
    RETURNING am.id`;
  add("audience_members", members.length);

  // A person that collapsed onto the target's same-email person and that the
  // source org no longer references is now an orphan of this brand: drop it.
  const collapsed = await tx`
    DELETE FROM people p USING transfer_person_map m
    WHERE p.id = m.old_id AND m.matched AND NOT m.shared
      AND NOT EXISTS (SELECT 1 FROM audience_members x WHERE x.person_id = p.id)
    RETURNING p.id`;
  add("people", movedPeople.length + copiedPeople.length + collapsed.length);

  await tx`DROP TABLE transfer_person_map`;
}

async function moveMethodologies(
  tx: Tx,
  fromOrg: string,
  fromBrand: string,
  toOrg: string,
  toBrand: string,
  add: (t: TableName, n: number) => void
): Promise<void> {
  // Solo-brand rows only: a co-brand methodology belongs to several brands and
  // stays with the org that still holds the others.
  const meths = await tx`
    UPDATE human_methodologies SET org_id = ${toOrg}, brand_ids = ARRAY[${toBrand}]::text[], updated_at = now()
    WHERE org_id = ${fromOrg}
      AND array_length(brand_ids, 1) = 1 AND brand_ids[1] = ${fromBrand}
    RETURNING human_id`;
  add("human_methodologies", meths.length);
  // The expert profile follows its (1:1) methodology — including one an
  // earlier call moved while leaving the human behind.
  const humansMoved = await tx`
    UPDATE humans h SET org_id = ${toOrg}, updated_at = now()
    FROM human_methodologies m
    WHERE m.human_id = h.id AND h.org_id <> ${toOrg}
      AND m.org_id = ${toOrg}
      AND array_length(m.brand_ids, 1) = 1 AND m.brand_ids[1] = ${toBrand}
    RETURNING h.id`;
  add("humans", humansMoved.length);
}
