# ADR-V3-009 · EventBus + topic registry

**Status:** Accepted 2026-05-04 (T1-E landed in commit 5fd566b · 13 typed topics + envelope + drift guard live; 8/8 cross-tab + eventbus specs passing)
**Date:** 2026-05-03
**Decision-makers:** Marat
**Cross-link:** [ADR-V3-002](ADR-V3-002-dal-adapters.md), [ADR-V3-007](ADR-V3-007-foundation-first-sequencing.md), [ADR-V3-010](ADR-V3-010-store-adapter-shim.md), x-front `topicRegistry.ts` (audit 2026-05-03 → 9/10), x-front `eventbus.contract.test.ts`

## Context

v3 today writes events directly into a per-project ring buffer via `appendEvent(proj.events, kind, payload)`. There is no typed bus, no publish/subscribe API, no envelope shape, no cross-tab fan-out. Adopting Kafka or real-time collab later means touching every reducer case.

x-front (audit 2026-05-03) has a production-ready typed EventBus: `topicRegistry.ts` exports a literal-union `EventTopic` + `PayloadFor<T>` helpers; `EventBusService.publish<T>()` rejects unknown topics at compile time; 242 call sites across the codebase; `eventbus.contract.test.ts` pins the topic baseline to prevent index-signature escape hatches.

x-docs `XLOOOP_CONCURRENCY_ASYNC_AND_XCP_ROADMAP_GAPS.md` G-ASYNC-2 explicitly defers real-time multi-user sync to Stage 4 / 10K+ users. v3 leapfrogging here is *net-new for the ecosystem* — not a reinvention.

## Decision

**v3 ships a typed EventBus with topic registry mirroring x-front's pattern, plus a BroadcastChannel adapter that x-front does not have.**

### API
```ts
// shared/services/eventbus
publish<T extends EventTopic>(topic: T, payload: PayloadFor<T>): void
subscribe<T extends EventTopic>(topic: T, handler: (envelope: EventEnvelope<T>) => void): SubscriptionToken
unsubscribe(token: SubscriptionToken): void
useTopic<T extends EventTopic>(topic: T): EventEnvelope<T> | null
```

### Envelope shape (matches `runtime/event-envelope.ts`, x-front-compatible, Kafka-message-ready)
```ts
interface EventEnvelope<T extends EventTopic = EventTopic> {
  event_id: string;
  type: T;
  version: 'v1';
  workspace_id: string;
  project_id: string | null;
  actor_id: string;
  timestamp: string;       // ISO 8601
  causation_id: string | null;
  correlation_id: string;
  visibility: 'system-internal' | 'agency-visible' | 'client-visible';
  payload: PayloadFor<T>;
}
```

### Initial topic set (extensible; locked by `runtime/topic-registry.ts` types-only paired file per ADR-V3-006)
```
wi.created · wi.promoted · wi.signed · wi.changes-requested
slice.shipped · slice.reopened
gate.passed · gate.failed
decision-record.created
client.review.requested · client.review.acknowledged · client.review.changes-requested
policy.violation
```

### Adapters (subscriber pattern; swappable)
- **PersistAdapter** — subscribes `*`; writes to `localStorage.xcp.v3.events.v1` (capped FIFO). Becomes the DAL seam (ADR-V3-002) when backend lands.
- **BroadcastChannelAdapter** — subscribes `*`; forwards via `new BroadcastChannel('xcp.v3.bus.v1')`; tenant-scoped (drops envelopes whose `workspace_id` doesn't match active session).
- **(Future) WebSocketKafkaAdapter** — replaces BroadcastChannelAdapter when backend lands; same publish API; backend Kafka consumer fans out to other tenants' tabs via WS.

### Reducer integration
Every reducer case that calls `appendEvent(proj.events, kind, payload)` ALSO calls `eventbus.publish(<topic>, envelope)`. The reducer keeps the in-state ring buffer for the activity feed (UI-local); the bus is the **canonical event channel**.

`correlation_id` flows through chains: a command issued by Sign-off shares its `correlation_id` across all events emitted by the resulting reducer transitions.

### Drift guard
- `runtime/topic-registry.ts` (types-only) declares the canonical literal-union and payload shapes per ADR-V3-006 G1 dual-file pattern.
- `shared/services/topic-registry.jsx` (runtime) declares the same set of strings.
- `smoke-cli` enforces both files name the exact same set of topics.

**Rejected alternative:** "Keep `appendEvent` and add typed wrapper later." Rejected because Phase 5 multiplies emit sites; retrofitting later means refactoring every consumer.

## Consequences

**Positive:**
- Every state transition is observable via subscription. UI consumers (HomeRow, Activity feed, future Client Review) subscribe to topics, not to reducer state.
- Cross-tab demo works without backend (BroadcastChannelAdapter).
- Kafka swap is `s/BroadcastChannelAdapter/WebSocketKafkaAdapter/` — no consumer changes.
- `runtime/event-envelope.ts` (currently dead surface) becomes a live import in T2-C.
- Future RTC (presence, cursors) reuses the same `publish/subscribe` API on `presence.*` topics.

**Negative:**
- T1-E touches every reducer case (~30–40 line diff in `app.jsx`). One-time pain.
- Memory/performance footprint grows: every event now flows through subscriber map. Mitigated by capped subscriber lists + tenant-scoped filter.
- Debugging story changes: instead of "set breakpoint in reducer," now "subscribe to topic in DevTools" (`window.__xbus.history(topic, limit)` helper added).

**Out of scope:**
- Real Kafka. Real backend. Real OIDC.
- CRDT for multiplayer text editing — opt-in per surface when needed.

## Verification

- `tests/e2e/v3-eventbus.spec.ts` — boots app, drives Sign-off `reject`, asserts subscriber receives `wi.changes-requested` envelope with matching `correlation_id`.
- `tests/e2e/v3-cross-tab-bus.spec.ts` — opens two browser contexts, drives `client.review.acknowledged` from one, asserts other receives within 200 ms.
- `v3/project/v3/__contracts__/eventbus.contract.test.ts` (port from x-front, type-only) — asserts every topic in `topic-registry.jsx` has a typed payload in `runtime/topic-registry.ts`.
- `smoke-cli` checks: `eventbus.jsx defines publish/subscribe`, `topic-registry.jsx topics match runtime/topic-registry.ts`, `every appendEvent call site has a sibling publish call`, `BroadcastChannelAdapter wired`.
- `runBootCheck` adds `eventbus rendered`, `broadcast adapter active`.

## References

- x-front `src/shared/services/eventbus/topicRegistry.ts` (canonical reference)
- x-front `src/__contracts__/eventbus.contract.test.ts` (port target)
- [ADR-V3-002 DAL adapters](ADR-V3-002-dal-adapters.md)
- [ADR-V3-006 TypeScript migration](ADR-V3-006-typescript-migration.md) (G1 dual-file pattern)
- [ADR-V3-010 StoreAdapter shim](ADR-V3-010-store-adapter-shim.md)
- x-docs `XLOOOP_CONCURRENCY_ASYNC_AND_XCP_ROADMAP_GAPS.md` (confirms RTC is net-new for ecosystem)
- [plan-foundation-2026-05-03.md](../plan-foundation-2026-05-03.md) §2.5 + §2.7
