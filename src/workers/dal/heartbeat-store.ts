// heartbeat-store.ts · AR-2.5 / OAR Phase-9 (260713) · DAL for the health control plane (mig-072).
//
// House store pattern (dal/role-skill-resolution-store.ts): free `...Row` fn, first param `sql: Sql`,
// tagged-template parameterized INSERT, degrade-safe (a heartbeat write must never break the path it
// observes). INERT: no producer calls these yet — the per-scope producers are the next step. Classify
// with lib/heartbeat.ts before writing (dead-man wins), then persist the verdict here.

import type { Sql } from '../db/client';
import type { HeartbeatScope, HeartbeatStatus } from '../lib/heartbeat';

export interface HeartbeatRowInput {
  scope: HeartbeatScope;
  /** NULL for platform scope (operator-only by RLS) */
  workspace_id: string | null;
  producer: string;
  sequence: number;
  observed_at: Date;
  expires_at: Date;
  /** the classified status (from classifyHeartbeatStatus) — dead-man already applied */
  status: HeartbeatStatus;
  /** customer-safe one-liner (no internal ids); <= 1000 chars */
  safe_summary: string;
  /** internal-only diagnostic; never customer-projected */
  internal_detail?: Record<string, unknown> | null;
  /** optional integrity hash of the canonical beat body */
  content_sha256?: string | null;
  schema_version?: string;
}

export async function insertHeartbeatRow(sql: Sql, input: HeartbeatRowInput): Promise<void> {
  const id = `hb_${crypto.randomUUID()}`;
  await sql/*sql*/`
    INSERT INTO system_heartbeats (
      id, scope, workspace_id, producer, sequence, observed_at, expires_at, status,
      schema_version, safe_summary, internal_detail, content_sha256
    ) VALUES (
      ${id}, ${input.scope}, ${input.workspace_id}, ${input.producer}, ${input.sequence},
      ${input.observed_at.toISOString()}, ${input.expires_at.toISOString()}, ${input.status},
      ${input.schema_version ?? 'v1'}, ${input.safe_summary},
      ${input.internal_detail == null ? null : JSON.stringify(input.internal_detail)}::jsonb,
      ${input.content_sha256 ?? null}
    )
  `;
}

export interface HealthRollupRowInput {
  scope: HeartbeatScope;
  workspace_id: string | null;
  status: HeartbeatStatus;
  counts: Record<HeartbeatStatus, number>;
  window_start: Date;
  window_end: Date;
  generated_at: Date;
}

export async function insertHealthRollupRow(sql: Sql, input: HealthRollupRowInput): Promise<void> {
  const id = `hr_${crypto.randomUUID()}`;
  const c = input.counts;
  await sql/*sql*/`
    INSERT INTO health_rollups (
      id, scope, workspace_id, status,
      healthy_count, degraded_count, stale_count, failed_count, expected_dark_count,
      window_start, window_end, generated_at
    ) VALUES (
      ${id}, ${input.scope}, ${input.workspace_id}, ${input.status},
      ${c.healthy}, ${c.degraded}, ${c.stale}, ${c.failed}, ${c.expected_dark},
      ${input.window_start.toISOString()}, ${input.window_end.toISOString()}, ${input.generated_at.toISOString()}
    )
  `;
}
