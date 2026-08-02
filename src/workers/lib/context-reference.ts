export type ContextReferenceKind = 'document' | 'source' | 'evidence';

export interface ContextReference {
  kind: ContextReferenceKind;
  id: string;
}

const ALLOWED_KINDS = new Set<ContextReferenceKind>(['document', 'source', 'evidence']);
const MAX_CONTEXT_REFERENCES = 8;
const MAX_REFERENCE_ID_LENGTH = 200;

export class ContextReferenceValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ContextReferenceValidationError';
  }
}

/**
 * Normalize customer-selected context into immutable, exact references. Kind-only
 * references are rejected because they cannot prove which tenant fact grounded a run.
 */
export function parseContextReferences(value: unknown): ContextReference[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ContextReferenceValidationError('context_refs must be an array');
  }
  if (value.length > MAX_CONTEXT_REFERENCES) {
    throw new ContextReferenceValidationError(`context_refs supports at most ${MAX_CONTEXT_REFERENCES} items`);
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new ContextReferenceValidationError(`context_refs[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    const kind = String(row.kind ?? '').trim() as ContextReferenceKind;
    const id = String(row.id ?? '').trim();
    if (!ALLOWED_KINDS.has(kind)) {
      throw new ContextReferenceValidationError(`context_refs[${index}].kind is unsupported`);
    }
    if (!id || id.length > MAX_REFERENCE_ID_LENGTH) {
      throw new ContextReferenceValidationError(`context_refs[${index}].id must be 1-${MAX_REFERENCE_ID_LENGTH} characters`);
    }
    const key = `${kind}:${id}`;
    if (seen.has(key)) {
      throw new ContextReferenceValidationError(`context_refs contains duplicate ${kind} reference`);
    }
    seen.add(key);
    return { kind, id };
  });
}

export function documentContextReferences(refs: readonly ContextReference[]): ContextReference[] {
  return refs.filter((ref) => ref.kind === 'document');
}
