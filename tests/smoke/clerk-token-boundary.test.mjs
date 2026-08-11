import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../src/workers/', import.meta.url));
const allowed = 'services/clerk-token-verifier.ts';

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(path);
    }
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

test('Clerk token SDK access is isolated behind one adapter', () => {
  const directImports = sourceFiles(root).filter((path) => {
    const source = readFileSync(path, 'utf8');
    return /import\s*\{[^}]*\bverifyToken\b[^}]*\}\s*from\s*['"]@clerk\/backend['"]/.test(source);
  }).map((path) => relative(root, path));

  assert.deepEqual(directImports, [allowed]);
});
