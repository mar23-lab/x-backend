import { describe, expect, it } from 'vitest';
import migration from '../db/migrations/100_customer_token_delegation_authority.sql?raw';

describe('migration 100 customer connector delegation authority', () => {
  it('adds explicit read-only default scopes for existing credentials', () => {
    const defaultScopes = migration.match(
      /ADD COLUMN IF NOT EXISTS scopes TEXT\[\][\s\S]*?\]::TEXT\[\]/,
    )?.[0] ?? '';

    expect(defaultScopes).toContain('NOT NULL DEFAULT ARRAY');
    expect(defaultScopes).toContain("'read:session'");
    expect(defaultScopes).toContain("'read:packets'");
    expect(defaultScopes).not.toContain("'write:");
  });

  it('binds delegated credentials to one membership activation epoch', () => {
    expect(migration).toContain("authority_mode TEXT NOT NULL DEFAULT 'tenant_service'");
    expect(migration).toContain('issuer_membership_activated_at TIMESTAMPTZ');
    expect(migration).toContain("authority_mode IN ('tenant_service', 'delegated_user')");
    expect(migration).toContain(
      "authority_mode <> 'delegated_user' OR issuer_membership_activated_at IS NOT NULL",
    );
    expect(migration).toMatch(
      /ON customer_api_tokens \(workspace_id, created_by, issuer_membership_activated_at\)[\s\S]*WHERE authority_mode = 'delegated_user' AND revoked_at IS NULL/,
    );
  });

  it('records migration 100 idempotently without storing raw connector credentials', () => {
    expect(migration).toMatch(/VALUES \(100, 'Customer connector scopes and delegated-membership authority binding'/);
    expect(migration).toContain('ON CONFLICT (version) DO NOTHING');
    expect(migration).not.toMatch(/ADD COLUMN IF NOT EXISTS\s+(raw_)?token\s/i);
  });
});
