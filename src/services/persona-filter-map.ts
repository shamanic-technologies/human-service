// Maps the LEGACY brand-service persona filter vocabulary into the canonical
// `PeopleSearchFiltersSchema` vocabulary that audiences (and the people gateway)
// speak. Used in two places:
//   1. the persona->audience backfill, on insert (so new rows are born canonical)
//   2. the one-time in-place re-map of already-backfilled audiences
//
// Persona vocab (old) -> canonical (new):
//   industry        -> industries        (verbatim values)
//   jobTitles       -> titles            (verbatim)
//   keywords        -> keywords          (verbatim)
//   technologies    -> technologies      (verbatim)
//   fundingStage    -> fundingStages     (verbatim)
//   revenueRange    -> revenueRanges     (verbatim)
//   seniority       -> seniorities       (lowercase, keep only enum values)
//   department      -> functions         (lowercase, spaces->_, dedupe)
//   location        -> locationCountries (best-effort: all values -> countries, NO split)
//   employeeRange   -> employeeMin/Max   (parse buckets; "N+" -> open max)
//
// FAIL LOUD: a persona key with no canonical target (schema drift), or a value
// that is structurally unrepresentable (wrong type, unparseable employee bucket),
// throws `PersonaFilterMapError` rather than silently dropping a representable
// filter. Value-level drops that the brief explicitly allows (non-enum seniority)
// are NOT failures. Already-canonical keys pass through unchanged (idempotency).

import { PeopleSearchFiltersSchema } from "../schemas.js";

export class PersonaFilterMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaFilterMapError";
  }
}

// Canonical key set, derived from the schema so it can never drift out of sync.
const CANONICAL_KEYS = new Set(Object.keys(PeopleSearchFiltersSchema.shape));

// The seniority enum honored by the canonical schema. Values outside it are
// dropped (brief: "keep only valid enum values, drop the rest rather than invent").
const SENIORITY_ENUM = new Set([
  "entry",
  "senior",
  "manager",
  "director",
  "vp",
  "c_suite",
  "owner",
  "founder",
  "partner",
]);

// Persona-ONLY keys — legacy keys that DIFFER from the canonical vocabulary and
// therefore signal a row that still needs re-mapping. `keywords` and
// `technologies` are deliberately excluded: those names are identical in both
// vocabularies (already canonical), so their presence does NOT mean stale vocab.
// The mapper handles them via the canonical-passthrough branch (verbatim).
const PERSONA_KEYS = new Set([
  "industry",
  "jobTitles",
  "fundingStage",
  "revenueRange",
  "seniority",
  "department",
  "location",
  "employeeRange",
]);

/** True if `key` is a legacy persona-only key (differs from canonical vocab). */
export function isPersonaVocabKey(key: string): boolean {
  return PERSONA_KEYS.has(key);
}

/** True if the filter blob contains at least one persona-vocab key. */
export function hasPersonaVocab(
  filters: Record<string, unknown> | null | undefined
): boolean {
  if (!filters) return false;
  return Object.keys(filters).some((k) => PERSONA_KEYS.has(k));
}

const uniq = (arr: string[]): string[] => [...new Set(arr)];

function asStringArray(key: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) {
    throw new PersonaFilterMapError(
      `persona filter '${key}' expected an array of strings, got ${JSON.stringify(
        value
      )}`
    );
  }
  return value as string[];
}

// Parse persona employeeRange buckets ("1-10", "11-50", "10001+") into a single
// numeric range honored by BOTH apollo (expanded to range labels) and apify.
// Lossy on non-contiguous buckets (the gap is included) — explicitly acceptable.
function parseEmployeeRange(buckets: string[]): {
  employeeMin?: number;
  employeeMax?: number;
} {
  let min = Infinity;
  let max = 0;
  let open = false;
  for (const b of buckets) {
    const closed = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(b);
    const openEnded = /^\s*(\d+)\s*\+\s*$/.exec(b);
    if (closed) {
      min = Math.min(min, Number(closed[1]));
      max = Math.max(max, Number(closed[2]));
    } else if (openEnded) {
      min = Math.min(min, Number(openEnded[1]));
      open = true;
    } else {
      throw new PersonaFilterMapError(
        `unparseable employeeRange bucket: '${b}'`
      );
    }
  }
  const out: { employeeMin?: number; employeeMax?: number } = {};
  if (min !== Infinity) out.employeeMin = min;
  // An open-ended bucket ("N+") leaves the upper bound unbounded -> omit max.
  if (!open && max > 0) out.employeeMax = max;
  return out;
}

/**
 * Translate a (possibly persona-vocab) filter blob into the canonical
 * `PeopleSearchFilters` shape. Idempotent: a fully-canonical input is returned
 * unchanged. Throws `PersonaFilterMapError` on schema drift / unrepresentable
 * values.
 */
export function mapPersonaFiltersToCanonical(
  raw: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const addArray = (key: string, values: string[]): void => {
    const existing = (out[key] as string[] | undefined) ?? [];
    const merged = uniq([...existing, ...values]);
    if (merged.length) out[key] = merged;
    else delete out[key];
  };

  for (const [key, value] of Object.entries(raw ?? {})) {
    switch (key) {
      case "industry":
        addArray("industries", asStringArray(key, value));
        break;
      case "jobTitles":
        addArray("titles", asStringArray(key, value));
        break;
      case "fundingStage":
        addArray("fundingStages", asStringArray(key, value));
        break;
      case "revenueRange":
        addArray("revenueRanges", asStringArray(key, value));
        break;
      case "location":
        // Best-effort: all values -> countries, NO city/state split (apollo
        // flattens location tiers anyway; a classifier would be invented heuristic).
        addArray("locationCountries", asStringArray(key, value));
        break;
      case "seniority": {
        const mapped = uniq(
          asStringArray(key, value).map((s) => s.toLowerCase().trim())
        ).filter((s) => SENIORITY_ENUM.has(s));
        addArray("seniorities", mapped);
        break;
      }
      case "department": {
        const mapped = uniq(
          asStringArray(key, value).map((s) =>
            s.toLowerCase().trim().replace(/\s+/g, "_")
          )
        );
        addArray("functions", mapped);
        break;
      }
      case "employeeRange": {
        const { employeeMin, employeeMax } = parseEmployeeRange(
          asStringArray(key, value)
        );
        if (employeeMin !== undefined) {
          out.employeeMin =
            typeof out.employeeMin === "number"
              ? Math.min(out.employeeMin, employeeMin)
              : employeeMin;
        }
        if (employeeMax !== undefined) {
          out.employeeMax =
            typeof out.employeeMax === "number"
              ? Math.max(out.employeeMax, employeeMax)
              : employeeMax;
        }
        break;
      }
      default: {
        if (CANONICAL_KEYS.has(key)) {
          // Already canonical -> passthrough unchanged (idempotency). Union if
          // the same canonical key also arrived via a persona key.
          if (Array.isArray(value) && Array.isArray(out[key])) {
            out[key] = uniq([
              ...(out[key] as string[]),
              ...(value as string[]),
            ]);
          } else if (out[key] === undefined) {
            out[key] = value;
          }
        } else {
          throw new PersonaFilterMapError(
            `unmappable persona filter key '${key}' — no canonical target ` +
              `(fail loud to avoid silent data loss)`
          );
        }
      }
    }
  }

  // Guarantee the output round-trips through the audiences Zod with zero
  // stripping: only canonical keys are present, and parse() fails loud on any
  // representable-but-invalid value.
  return PeopleSearchFiltersSchema.parse(out) as Record<string, unknown>;
}
