// validate.ts · zero-dep JSON Schema validator covering the subset we use
// in tool inputSchema definitions (type, properties, required, additionalProperties,
// minimum, maximum, items, integer-vs-number).
//
// Why hand-rolled instead of ajv:
//   - ajv adds ~600KB minified for one validate-per-call use case
//   - our subset is small and stable; tools schemas don't use $ref, oneOf, etc.
//   - keeps the package dependency surface to one (the MCP SDK itself)
//
// Validation result: returns null if valid; otherwise a string describing
// the first violation (terminate-early; the SDK will surface it as VALIDATION_ERROR).

export interface SchemaSubset {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  properties?: Record<string, SchemaSubset>;
  required?: readonly string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  items?: SchemaSubset;
  description?: string;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function check(value: unknown, schema: SchemaSubset, path: string): string | null {
  // Type check
  if (schema.type) {
    const actual = typeOf(value);
    const want = schema.type;
    // `number` accepts integer; `integer` requires integer
    const ok =
      actual === want ||
      (want === 'number' && actual === 'integer');
    if (!ok) {
      return `${path || '<root>'}: expected ${want}, got ${actual}`;
    }
  }
  if (schema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    const knownKeys = new Set(Object.keys(properties));
    // additionalProperties default true (per JSON Schema spec) — we enforce ours
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!knownKeys.has(k)) {
          return `${path || '<root>'}.${k}: unknown property (additionalProperties=false)`;
        }
      }
    }
    if (schema.required) {
      for (const r of schema.required) {
        if (obj[r] === undefined) {
          return `${path || '<root>'}.${r}: required`;
        }
      }
    }
    for (const [k, sub] of Object.entries(properties)) {
      if (obj[k] !== undefined) {
        const child = check(obj[k], sub, path ? `${path}.${k}` : k);
        if (child) return child;
      }
    }
  }
  if ((schema.type === 'integer' || schema.type === 'number') && typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${path || '<root>'}: ${value} < minimum ${schema.minimum}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${path || '<root>'}: ${value} > maximum ${schema.maximum}`;
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const child = check(value[i], schema.items, `${path}[${i}]`);
      if (child) return child;
    }
  }
  return null;
}

/** Validate args against a tool's inputSchema. Returns null if valid, error message otherwise. */
export function validateAgainst(schema: SchemaSubset, args: unknown): string | null {
  return check(args, schema, '');
}
