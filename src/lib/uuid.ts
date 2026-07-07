// Version-agnostic UUID shape check. Org ids can predate the v4 convention
// (see the "lax uuid" notes on the resolver schema + `humans.org_id text`), so
// we validate the CANONICAL SHAPE (8-4-4-4 hex + 12 hex) rather than the v4
// version/variant nibbles.
//
// This exists to reject a MALFORMED identity value before it reaches a
// uuid-typed query — most importantly a doubled / comma-joined value
// (`"<uuid>,<uuid>"` produced when an upstream forwards `x-org-id` twice and
// Node joins the duplicates with a comma). Such a value is not valid uuid input,
// so Postgres rejects it at query time with `22P02 invalid input syntax for type
// uuid`; validating the shape at the edge turns it into a clean 400.
//
// The auth middleware validates the same shape on identity HEADERS (its own
// inline `UUID_RE` + comma-dedup); this helper is the canonical home used by
// the internal resolver's BODY orgId (service-to-service, no header path).
export const LAX_UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && LAX_UUID_REGEX.test(value);
}
