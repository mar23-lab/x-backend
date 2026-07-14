// src/workers/__tests__/__mocks__/snakecase-keys.mjs
// ESM shim for snakecase-keys@8.0.1 which uses require() internally
// but declares itself as ESM — causing "Cannot use require()" in Miniflare.
//
// This shim re-implements the minimal API surface needed by @clerk/backend.
// The actual conversion logic is a lightweight re-implementation using standard
// ES string methods (no CJS deps).

function toSnakeCase(str) {
  return String(str)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function convertKeys(obj, opts = {}) {
  if (Array.isArray(obj)) {
    return obj.map(item => convertKeys(item, opts));
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        toSnakeCase(k),
        opts.deep !== false ? convertKeys(v, opts) : v,
      ])
    );
  }
  return obj;
}

export default convertKeys;
export { convertKeys as snakecaseKeys };
