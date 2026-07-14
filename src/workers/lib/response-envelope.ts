// response-envelope.ts · M3 (260707) · the customer-facing data-class truth surface.
//
// Every tenant-facing response declares exactly one `data_class` so a consumer (the current cockpit,
// and the future UI) can NEVER mislabel starter/template content as the customer's live records.
// Vocabulary + enforcement are the SSOT in docs/security/DATA_CLASSIFICATION.md. This is additive:
// it wraps an existing payload object, leaving all existing fields byte-identical and only adding the
// `data_class` key — so no consumer breaks.

export type DataClass = 'live' | 'starter' | 'template' | 'redacted' | 'public_safe';

/**
 * Attach a `data_class` to a response payload object. Returns a new object (existing keys preserved).
 * Use at every tenant-facing `ctx.json(...)` return so the class is declared, never inferred.
 */
export function withDataClass<T extends object>(payload: T, dataClass: DataClass): T & { data_class: DataClass } {
  // T extends object (not Record<string, unknown>) so typed route payloads are accepted without an
  // index signature; object spread is valid for any object shape and the result type is preserved.
  return { ...payload, data_class: dataClass };
}
