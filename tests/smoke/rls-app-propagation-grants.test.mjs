import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const grants = readFileSync(
  new URL('../../src/workers/db/operations/rls_app_role_grants.sql', import.meta.url),
  'utf8',
);

test('restricted app role has minimum propagation operations', () => {
  assert.match(grants, /GRANT SELECT, UPDATE ON propagation_tick_state TO xlooop_app/);
  assert.match(grants, /GRANT SELECT, UPDATE ON synthetic_domain_propagation_rules TO xlooop_app/);
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON synthetic_domain_recommendations TO xlooop_app/);
});

test('restricted propagation grants exclude delete and DDL authority', () => {
  assert.doesNotMatch(grants, /GRANT[^;]*DELETE[^;]*propagation_/);
  assert.doesNotMatch(grants, /GRANT[^;]*(CREATE|TRUNCATE)[^;]*propagation_/);
});
