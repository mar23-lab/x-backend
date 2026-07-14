// env-flag.ts · tolerant truthy read for env flags set via the Cloudflare dashboard.
//
// The dashboard stores Text values literally, so an operator who enters `"true"` (WITH
// surrounding quotes) would defeat a strict `=== 'true'` check — the exact Part O.4
// readiness-gate failure. Normalize before comparing: strip surrounding quotes + whitespace,
// lowercase, compare to 'true'. `true`, `"true"`, `'true'`, ` true `, `TRUE` all read as
// true; anything else (false / unset / `1` / `yes` / `truthy`) reads as false (no over-loosening).
export function envFlagTrue(v?: string): boolean {
  return String(v ?? '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim()
    .toLowerCase() === 'true';
}
