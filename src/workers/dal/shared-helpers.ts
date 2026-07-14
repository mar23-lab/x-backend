// shared-helpers.ts · shared DAL utilities (R56 Stage 0 consolidation)
//
// Single source of truth for two helpers that were previously copy-pasted in three files:
// customer-authority-store.ts, customer-readiness-store.ts, and WorkersDalAdapter.ts. The SQL-only
// stores and the Neon adapter import from here so ID generation + error shaping stay identical.

export interface DalError extends Error {
  code: string;
  status: number;
}

/** Construct a typed DAL error carrying a stable `code` and an HTTP `status`. */
export function makeError(code: string, message: string, status: number): DalError {
  const err = new Error(message) as DalError;
  err.code = code;
  err.status = status;
  return err;
}

/** URL-safe random id (16 random bytes, base64url, unpadded) for DAL row primary keys. */
export function randomNanoid(): string {
  const buf = new Uint8Array(16);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis.crypto as any).getRandomValues(buf);
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    s += String.fromCharCode(buf[i]!);
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
