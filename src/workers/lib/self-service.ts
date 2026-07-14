// self-service.ts · customer self-service (roadmap re-entry, event soft-delete + rollback) config.
//
// The rollback retention window: a soft-deleted item is restorable for this many days, after which
// the purge cron (F3) hard-deletes it. The Profile "recently deleted" countdown is derived as
// `archived_at + ROLLBACK_WINDOW_DAYS - now`. This constant MUST be the single source of truth
// shared by the E3 recently-deleted read, the rollback UI, and the F3 purge cron — so the
// displayed countdown can never disagree with when the purge actually runs. (Operator-chosen
// 260628: 30 days. Tunable here without a migration.)
export const ROLLBACK_WINDOW_DAYS = 30;
