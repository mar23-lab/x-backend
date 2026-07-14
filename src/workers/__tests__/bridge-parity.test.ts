// bridge-parity.test.ts — ABS-P1b · the pure bridge-envelope v1 + dead-man freshness classifier.
// Locks the semantics against the Parity Sentinel's assess_freshness contract: a LIVE bridge stale/dark
// alarms; a non-live bridge dark is expected_dark (no alarm); envelope status degrades on any live alarm.
import { describe, it, expect } from 'vitest';
import {
  classifyBridgeFreshness, buildBridgeParityManifest, BRIDGE_SCHEMA_VERSION,
} from '../lib/bridge-parity';

const NOW = new Date('2026-07-13T12:00:00Z');
const HOUR = 3600;

describe('bridge-parity dead-man classifier (ABS-P1b)', () => {
  it('LIVE + recent ingest ⇒ fresh, no alarm', () => {
    const c = classifyBridgeFreshness(
      { bridge_id: 'domain-plan', registry_status: 'live', last_ingest_at: '2026-07-13T11:30:00Z', threshold_seconds: HOUR }, NOW);
    expect(c.verdict).toBe('fresh');
    expect(c.alarm).toBe(false);
    expect(c.age_seconds).toBe(1800);
  });

  it('LIVE + past threshold ⇒ stale + ALARM', () => {
    const c = classifyBridgeFreshness(
      { bridge_id: 'domain-plan', registry_status: 'live', last_ingest_at: '2026-07-13T09:00:00Z', threshold_seconds: HOUR }, NOW);
    expect(c.verdict).toBe('stale');
    expect(c.alarm).toBe(true);
  });

  it('LIVE + never ingested ⇒ no_signal + ALARM (dead-man)', () => {
    const c = classifyBridgeFreshness(
      { bridge_id: 'domain-plan', registry_status: 'live', last_ingest_at: null, threshold_seconds: HOUR }, NOW);
    expect(c.verdict).toBe('no_signal');
    expect(c.alarm).toBe(true);
    expect(c.age_seconds).toBeNull();
  });

  it('non-live (manual) + stale ⇒ expected_dark, NO alarm', () => {
    const c = classifyBridgeFreshness(
      { bridge_id: 'manual-bridge', registry_status: 'manual', last_ingest_at: '2026-07-01T00:00:00Z', threshold_seconds: HOUR }, NOW);
    expect(c.verdict).toBe('expected_dark:stale');
    expect(c.alarm).toBe(false);
  });

  it('non-live (broken) + never ingested ⇒ expected_dark:no_signal, NO alarm', () => {
    const c = classifyBridgeFreshness(
      { bridge_id: 'broken-bridge', registry_status: 'broken', last_ingest_at: null, threshold_seconds: HOUR }, NOW);
    expect(c.verdict).toBe('expected_dark:no_signal');
    expect(c.alarm).toBe(false);
  });

  it('unparseable last_ingest_at ⇒ n/a (live, not an alarm)', () => {
    const c = classifyBridgeFreshness(
      { bridge_id: 'x', registry_status: 'live', last_ingest_at: 'not-a-date', threshold_seconds: HOUR }, NOW);
    expect(c.verdict).toBe('n/a');
    expect(c.alarm).toBe(false);
    expect(c.age_seconds).toBeNull();
  });
});

describe('bridge-parity manifest envelope v1', () => {
  it('ok when all live bridges fresh; carries schema version + generated_at', () => {
    const m = buildBridgeParityManifest([
      { bridge_id: 'a', registry_status: 'live', last_ingest_at: '2026-07-13T11:59:00Z', threshold_seconds: HOUR },
      { bridge_id: 'b', registry_status: 'manual', last_ingest_at: null, threshold_seconds: HOUR }, // expected_dark
    ], NOW);
    expect(m.bridge_schema_version).toBe(BRIDGE_SCHEMA_VERSION);
    expect(m.generated_at).toBe('2026-07-13T12:00:00.000Z');
    expect(m.status).toBe('ok');
    expect(m.alarm_count).toBe(0);
    expect(m.bridges).toHaveLength(2);
  });

  it('degraded when ≥1 live bridge alarms; expected_dark does NOT degrade', () => {
    const m = buildBridgeParityManifest([
      { bridge_id: 'a', registry_status: 'live', last_ingest_at: null, threshold_seconds: HOUR },       // no_signal ALARM
      { bridge_id: 'b', registry_status: 'broken', last_ingest_at: null, threshold_seconds: HOUR },     // expected_dark
      { bridge_id: 'c', registry_status: 'live', last_ingest_at: '2026-07-13T11:59:00Z', threshold_seconds: HOUR }, // fresh
    ], NOW);
    expect(m.status).toBe('degraded');
    expect(m.alarm_count).toBe(1);
  });
});
