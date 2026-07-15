// agent-digest.ts · the first "governed agent does real work" action.
//
// A deterministic agent that DRAFTS a workspace digest from the activity summary, posted as a
// PENDING proposal (status='needs_review', approval_state='pending') into the existing approval
// spine: it lands in the "needs you" queue → operator POST /sign-offs (approved) → it becomes a
// governed, official record. The operator vets the agent's output before it's official — that's
// the "governed" half. Deterministic v1; an LLM can produce richer drafts later through the same
// proposal → approve loop. Customer-safe vocab.

import type { WorkspaceActivitySummary } from '../dal/workspace-activity-store';
import { companyDescriptor, type CustomerContextProfile } from '../dal/customer-context-store';
import type { ModelExecutionObserver } from '../lib/model-execution-lineage';

export interface DigestProposal {
  summary: string;
  body: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Compile a workspace digest from the activity summary. Pure + deterministic. */
export function buildWorkspaceDigest(s: WorkspaceActivitySummary): DigestProposal {
  const lines: string[] = [
    'Here is a snapshot of your workspace, compiled for you:',
    `• ${plural(s.events_total, 'event')} on record (${s.events_completed} completed)`,
    `• ${plural(s.signoffs_total, 'sign-off')}`,
    `• ${plural(s.projects_total, 'project')} · ${plural(s.connected_sources, 'connected source')}`,
    `• ${plural(s.days_of_history, 'day')} of history`,
  ];
  if (s.needs_you > 0) lines.push(`• ${plural(s.needs_you, 'item')} awaiting your review`);
  if (s.since && s.events_since > 0) lines.push(`• ${plural(s.events_since, 'new event')} since you were last here`);
  lines.push('', 'Approve to post this digest to your operations stream as a governed record, or reject to discard.');
  return {
    summary: `Workspace digest · ${plural(s.events_total, 'event')} on record`,
    body: lines.join('\n'),
  };
}

// ── LLM-richer draft (the moat: a governed agent does richer real work) ──────────────────────
//
// When a Cloudflare Workers-AI binding is present, the agent drafts a NARRATIVE digest via the
// model; otherwise (or on any error / empty / too-short output) it falls back to the deterministic
// buildWorkspaceDigest above. CRITICAL safety property: the result is STILL posted as a PENDING
// proposal that the operator must approve via /sign-offs — the LLM can NEVER post anything to the
// official record without human sign-off. The model is instructed to use ONLY the supplied facts
// (no invention), customer-safe, regulated-SMB tone. Decoupled from the exact @cloudflare/workers-types
// `Ai` shape via a minimal structural interface so a types-version bump can't break this.

/** Minimal structural type for the Workers-AI binding — just the `.run()` we use. */
export interface AiRunner {
  run(
    model: string,
    options: { messages: Array<{ role: string; content: string }>; max_tokens?: number },
  ): Promise<unknown>;
}

/** The Workers-AI text model used for digest drafting (small instruct model; free-tier friendly). */
export const DIGEST_LLM_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export interface DigestDraft extends DigestProposal {
  generated_by: 'llm' | 'deterministic';
}

const APPROVE_FOOTER = 'Approve to post this digest to your operations stream as a governed record, or reject to discard.';

/**
 * Draft a workspace digest, richer via the LLM when available, always governed + fail-safe.
 * Returns `generated_by` so the caller can record provenance. Never throws — any failure degrades
 * to the deterministic digest (HR-INPUT-COERCION-NO-THROW-1 / HR-CONFIG-REALITY-MATCH-1 spirit:
 * a missing/failing binding surfaces as a deterministic fallback, never a 5xx).
 */
export async function buildWorkspaceDigestLLM(
  s: WorkspaceActivitySummary,
  ai?: AiRunner,
  executionObserver?: ModelExecutionObserver,
): Promise<DigestDraft> {
  const deterministic = buildWorkspaceDigest(s);
  if (!ai) return { ...deterministic, generated_by: 'deterministic' };
  const startedAt = Date.now();
  const execution = await executionObserver?.start({ provider: 'workers_ai', model_key: DIGEST_LLM_MODEL });
  let out: unknown;
  try {
    const facts: string[] = [
      `${plural(s.events_total, 'event')} on record, ${s.events_completed} completed`,
      plural(s.signoffs_total, 'sign-off'),
      plural(s.projects_total, 'project'),
      plural(s.connected_sources, 'connected source'),
      `${plural(s.days_of_history, 'day')} of history`,
    ];
    if (s.needs_you > 0) facts.push(`${plural(s.needs_you, 'item')} awaiting the operator's review`);
    if (s.since && s.events_since > 0) facts.push(`${plural(s.events_since, 'new event')} since the operator last visited`);

    out = await ai.run(DIGEST_LLM_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You write a concise weekly workspace digest for ' + companyDescriptor(null) + '. '
            + 'Use ONLY the facts provided — never invent numbers, names, events, or clients. Professional, plain, customer-safe '
            + 'English; no internal jargon, no markdown, no headings. 3 to 5 short sentences, then ONE concrete suggested next '
            + 'action on its own final line.',
        },
        { role: 'user', content: `Workspace facts: ${facts.join('; ')}.` },
      ],
      max_tokens: 320,
    });

  } catch (_) {
    await execution?.complete({ status: 'fallback', tokens_in: null, tokens_out: null, latency_ms: Date.now() - startedAt, error_code: 'MODEL_ERROR' });
    return { ...deterministic, generated_by: 'deterministic' };
  }
  const text = String(
      (out && typeof out === 'object' && 'response' in (out as Record<string, unknown>)
        ? (out as { response?: unknown }).response
        : '') ?? '',
    ).trim();
  if (text.length < 40) {
    await execution?.complete({ status: 'fallback', tokens_in: null, tokens_out: null, latency_ms: Date.now() - startedAt, error_code: 'SHORT_RESPONSE' });
    return { ...deterministic, generated_by: 'deterministic' };
  }
  const usage = out && typeof out === 'object' && 'usage' in (out as Record<string, unknown>)
    ? (out as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    : undefined;
  await execution?.complete({
    status: 'completed', tokens_in: usage?.prompt_tokens ?? null, tokens_out: usage?.completion_tokens ?? null,
    latency_ms: Date.now() - startedAt, error_code: null,
  });

  return {
      summary: deterministic.summary,
      body: `${text}\n\n${APPROVE_FOOTER}`,
      generated_by: 'llm',
  };
}

// ── DAY-1 governed welcome (the moat, visible at minute one) ─────────────────────────────────
//
// The instant the operator approves a customer and the workspace is auto-provisioned, the agent
// drafts a tailored WELCOME proposal into the new workspace — so the customer sees a governed
// agent doing real work from minute one, instead of waiting up to 6 days for the weekly digest
// sweep. Same governance contract as the digest: the draft lands as a PENDING proposal
// (status='needs_review', approval_state='pending', next_action='approve_to_post_digest') that
// the bell renders + approves via /sign-offs — it NEVER auto-posts. LLM-enriched when a Workers-AI
// binding is present; deterministic fallback otherwise. NEVER throws. Customer-safe vocab only.

export interface WelcomeDraftOpts {
  /** Display name of the customer/workspace (e.g. 'Honest & Young'). */
  customerName?: string | null;
  /** Number of day-1 roadmap items queued by the provisioner. */
  roadmapCount?: number | null;
  /** Workers-AI binding for LLM enrichment; absent → deterministic. */
  ai?: AiRunner;
  executionObserver?: ModelExecutionObserver;
}

export interface WelcomeDraft extends DigestProposal {
  generated_by: 'llm' | 'deterministic';
}

const WELCOME_APPROVE_FOOTER =
  'Approve to post this welcome to your operations stream as a governed record, or reject to discard.';

/** The ONE concrete first action, chosen from the real workspace state. Customer-safe. */
function welcomeFirstAction(s: WorkspaceActivitySummary): string {
  return s.connected_sources === 0
    ? 'Connect your first source to start capturing evidence.'
    : 'Review your day-1 roadmap and approve the first item.';
}

/**
 * Draft a tailored DAY-1 welcome for a freshly provisioned workspace. Richer than a generic
 * digest snapshot: a warm one-line welcome naming the workspace, a 2-3 bullet day-1 state, and
 * ONE concrete first action chosen from the real state. LLM-enriched when `opts.ai` is present
 * (no-invention, customer-safe, regulated-SMB tone — same guardrails as buildWorkspaceDigestLLM);
 * deterministic fallback otherwise. NEVER throws — any failure degrades to the deterministic
 * welcome (HR-INPUT-COERCION-NO-THROW-1 spirit: never a 5xx, always a usable draft).
 */
export async function buildOnboardingWelcomeDraft(
  s: WorkspaceActivitySummary,
  opts: WelcomeDraftOpts = {},
): Promise<WelcomeDraft> {
  // Coerce inputs defensively so a malformed caller can never make this throw.
  const name = (typeof opts.customerName === 'string' && opts.customerName.trim()) || 'your workspace';
  const roadmapCount = Number.isFinite(opts.roadmapCount as number) && (opts.roadmapCount as number) > 0
    ? Math.floor(opts.roadmapCount as number)
    : 0;
  const firstAction = welcomeFirstAction(s);

  // Deterministic baseline — always available, used as the fallback for the LLM path too.
  const stateBullets: string[] = [];
  if (roadmapCount > 0) stateBullets.push(`• ${plural(roadmapCount, 'roadmap item')} queued for your first day`);
  if (s.projects_total > 0) stateBullets.push(`• ${plural(s.projects_total, 'project')} set up and ready`);
  stateBullets.push(
    s.connected_sources > 0
      ? `• ${plural(s.connected_sources, 'connected source')} feeding in evidence`
      : '• No sources connected yet',
  );

  const deterministicBody = [
    `Welcome to ${name} — your workspace is set up and ready to go.`,
    '',
    'Here is where things stand on day one:',
    ...stateBullets,
    '',
    `Suggested first step: ${firstAction}`,
    '',
    WELCOME_APPROVE_FOOTER,
  ].join('\n');

  const deterministic: WelcomeDraft = {
    summary: `Welcome to ${name} — your workspace is ready`,
    body: deterministicBody,
    generated_by: 'deterministic',
  };

  if (!opts.ai) return deterministic;

  const startedAt = Date.now();
  const execution = await opts.executionObserver?.start({ provider: 'workers_ai', model_key: DIGEST_LLM_MODEL });
  let out: unknown;
  try {
    const facts: string[] = [`the workspace is named "${name}" and is freshly set up`];
    if (roadmapCount > 0) facts.push(`${plural(roadmapCount, 'day-1 roadmap item')} queued`);
    if (s.projects_total > 0) facts.push(`${plural(s.projects_total, 'project')} set up`);
    facts.push(
      s.connected_sources > 0
        ? `${plural(s.connected_sources, 'connected source')} feeding in evidence`
        : 'no sources connected yet',
    );
    facts.push(`the single suggested first step is: ${firstAction}`);

    out = await opts.ai.run(DIGEST_LLM_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You write a short, warm DAY-ONE welcome for ' + companyDescriptor(((opts as { companyContext?: CustomerContextProfile | null }).companyContext) ?? null) + ' '
            + 'whose workspace was just set up. Use ONLY the facts provided — never invent numbers, names, clients, events, '
            + 'or features. Professional, plain, customer-safe English; no internal jargon, no markdown, no headings. Start with '
            + 'a one-line welcome that names the workspace, then 2 to 3 short sentences on the day-one state, then end with the '
            + 'single suggested first step EXACTLY as provided, on its own final line.',
        },
        { role: 'user', content: `Facts: ${facts.join('; ')}.` },
      ],
      max_tokens: 320,
    });

  } catch (_) {
    await execution?.complete({ status: 'fallback', tokens_in: null, tokens_out: null, latency_ms: Date.now() - startedAt, error_code: 'MODEL_ERROR' });
    return deterministic;
  }
  const text = String(
      (out && typeof out === 'object' && 'response' in (out as Record<string, unknown>)
        ? (out as { response?: unknown }).response
        : '') ?? '',
    ).trim();
  if (text.length < 40) {
    await execution?.complete({ status: 'fallback', tokens_in: null, tokens_out: null, latency_ms: Date.now() - startedAt, error_code: 'SHORT_RESPONSE' });
    return deterministic;
  }
  const usage = out && typeof out === 'object' && 'usage' in (out as Record<string, unknown>)
    ? (out as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    : undefined;
  await execution?.complete({
    status: 'completed', tokens_in: usage?.prompt_tokens ?? null, tokens_out: usage?.completion_tokens ?? null,
    latency_ms: Date.now() - startedAt, error_code: null,
  });

  return {
      summary: deterministic.summary,
      body: `${text}\n\n${WELCOME_APPROVE_FOOTER}`,
      generated_by: 'llm',
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// OS-5 W2 · postApprovedDigest — the CONSUMER of next_action='approve_to_post_digest' (J2's missing
// last step). Until this, approval flipped approval_state and nothing else happened — worse, the
// approved proposal stayed status='needs_review', so the weekly sweep's idempotency check counted
// it pending FOREVER (blocking all future digests for the workspace). Closure = an ia-001-legal
// status re-point (needs_review → completed, an ATOMIC claim so racing approvals post exactly
// once) + an APPENDED receipt threaded under the proposal + a best-effort email. Never throws —
// called best-effort from the sign-offs route, a delivery failure must never block the sign-off.

import type { DalAdapter } from '../dal/DalAdapter';
import { notifyDigestPosted, type NotifierEnv } from './email-notifier';

export interface PostApprovedDigestResult {
  posted: boolean;
  reason: 'posted' | 'not_a_digest_proposal' | 'claim_lost' | 'not_found' | 'error';
}

export async function postApprovedDigest(
  dal: DalAdapter,
  env: NotifierEnv,
  workspaceId: string,
  eventId: string,
  now: () => Date,
): Promise<PostApprovedDigestResult> {
  try {
    const event = await dal.getEvent(workspaceId, eventId);
    if (!event) return { posted: false, reason: 'not_found' };
    // Only the digest proposal's approve has a post step; every other sign-off is unchanged.
    if (event.next_action !== 'approve_to_post_digest' || event.status !== 'needs_review') {
      return { posted: false, reason: 'not_a_digest_proposal' };
    }

    // Atomic claim — run-exactly-once posting (the queue consumer's exact pattern). This flip is
    // ALSO the sweep-blocking bug fix: a completed proposal no longer matches the sweep's
    // status='needs_review' idempotency scan.
    const claim = await dal.updateEventStatus(
      workspaceId, eventId, { status: 'completed' }, 'needs_review',
    );
    if (claim.updated === 0) return { posted: false, reason: 'claim_lost' };

    // Receipt — APPENDED (ia-001: results are new rows), deterministic id (idempotent), threaded
    // under the proposal via parent_event_id (migration 032) so the stream shows the closure.
    await dal.upsertEvent(workspaceId, {
      id: `evt_digest_posted_${eventId}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
      source_tool: 'xlooop',
      agent_id: 'xlooop:digest-agent',
      status: 'completed',
      summary: `[digest posted] ${String(event.summary || eventId).slice(0, 480)}`.slice(0, 512),
      body: 'Approved digest posted as the official record (sign-off -> post).',
      parent_event_id: eventId,
      visibility: 'internal_workspace',
      occurred_at: now().toISOString(),
    });

    // Delivery — best-effort, never blocks the post (sendVia degrades CF -> Resend -> console).
    try {
      await notifyDigestPosted(env, {
        workspace_id: workspaceId,
        summary: String(event.summary || 'Workspace digest'),
        body: String(event.body || ''),
      });
    } catch (_) { /* email is the optional rung */ }

    return { posted: true, reason: 'posted' };
  } catch (_) {
    return { posted: false, reason: 'error' };
  }
}
