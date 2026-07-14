// email-notifier.ts · Transactional email — Cloudflare Email Service (primary) + Resend fallback
//
// Authority: docs/architecture/backend/AUTH_TENANCY_MODEL.md §Admin notifications
//
// R55 (2026-06-07): migrated from a Resend-only path to Cloudflare Email Service — the in-ecosystem
// transactional pipe (native Workers `send_email` binding, NO API keys / secrets). This keeps email
// inside Cloudflare alongside Workers/Pages/DNS and removes the secret-management friction. It is
// independent of Google Workspace: Email *Sending* only touches SPF/DKIM on the sending (sub)domain
// and never MX, so Gmail receiving + human sending are unaffected.
//
// R56 Stage 3.2: added notifyCustomerApproved() (the customer "you're approved" email) and extracted
// the shared CF->Resend->console delivery ladder into sendVia() so both notifications share it.
//
// Delivery chain — each step is a graceful fallback; a failure NEVER blocks the caller:
//   1. Cloudflare Email Service  (env.EMAIL binding · from EMAIL_FROM_ADDRESS)    ← primary
//   2. Resend REST API           (env.RESEND_API_KEY · dormant unless configured) ← optional backup
//   3. Console / Workers Logs    (always logged for audit)                        ← last resort

export interface CfEmailBinding {
  send(message: {
    to: string | string[];
    from: { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ messageId?: string }>;
}

export interface NotifierEnv {
  ADMIN_NOTIFICATION_EMAIL?: string;
  EMAIL_FROM_ADDRESS?: string;
  EMAIL?: CfEmailBinding;
  // Optional Resend backup (dormant unless all set):
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  ENVIRONMENT?: string;
}

export interface AccessRequestNotification {
  request_id: string;
  email: string;
  company_name: string | null;
  reason: string | null;
  source: string | null;
  ip_address: string | null;
  created_at: string;
  account_type?: string | null;
  deep_level?: number | null;
  /** Part R · Stage B · false = anonymous website lead (no Clerk `users` row); true = registered; undefined = unknown. */
  registered?: boolean | null;
}

export interface CustomerApprovedNotification {
  email: string;
  company_name?: string | null;
  account_type?: string | null;
  /** Where the customer signs in once their workspace is ready (default https://app.xlooop.com). */
  app_url?: string | null;
}

export type NotifyChannel = 'cloudflare' | 'resend' | 'console';

export interface NotifyResult {
  delivered: boolean;
  channel: NotifyChannel;
  error?: string;
}

/**
 * Notify admin of a new access request. Never throws — notification failures must not block the
 * user-facing access request.
 */
export async function notifyAdminAccessRequest(
  env: NotifierEnv,
  payload: AccessRequestNotification
): Promise<NotifyResult> {
  const recipients = (env.ADMIN_NOTIFICATION_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Always log for audit (visible in Workers Logs even when email delivers).
  console.log(
    JSON.stringify({
      kind: 'admin_notification',
      type: 'access_request',
      request_id: payload.request_id,
      email: payload.email,
      recipients: recipients.length > 0 ? recipients : ['<no ADMIN_NOTIFICATION_EMAIL configured>'],
      env: env.ENVIRONMENT,
      timestamp: new Date().toISOString(),
    })
  );

  return sendVia(
    env,
    recipients,
    `[Xlooop] New ${payload.registered === false ? 'LEAD (not registered)' : 'access request'} — ${payload.email}`,
    () => renderAccessRequestEmail(payload),
    () => renderAccessRequestText(payload),
    'admin_notification_error'
  );
}

/**
 * Notify a customer that their access request was approved. Sent from the admin approve route (the
 * Worker context where env.EMAIL is available). Never throws — a notification failure must not block
 * the approval itself.
 */
export async function notifyCustomerApproved(
  env: NotifierEnv,
  payload: CustomerApprovedNotification
): Promise<NotifyResult> {
  const to = [payload.email].map((s) => (s || '').trim()).filter(Boolean);

  console.log(
    JSON.stringify({
      kind: 'customer_notification',
      type: 'access_approved',
      email: payload.email,
      env: env.ENVIRONMENT,
      timestamp: new Date().toISOString(),
    })
  );

  return sendVia(
    env,
    to,
    'Your Xlooop access is approved',
    () => renderCustomerApprovedEmail(payload),
    () => renderCustomerApprovedText(payload),
    'customer_notification_error'
  );
}

/**
 * Shared delivery ladder: Cloudflare Email Service → Resend (if configured) → console. The html/text
 * are produced by thunks so a render failure is caught here and degrades to console (never throws).
 */
async function sendVia(
  env: NotifierEnv,
  to: string[],
  subject: string,
  htmlFn: () => string,
  textFn: () => string,
  logKind: string
): Promise<NotifyResult> {
  let lastError: string | undefined;
  try {
    const html = htmlFn();
    const text = textFn();

    // 1. Cloudflare Email Service — primary (native binding, no secrets).
    if (env.EMAIL && env.EMAIL_FROM_ADDRESS && to.length > 0) {
      try {
        await env.EMAIL.send({
          to,
          from: { email: env.EMAIL_FROM_ADDRESS, name: 'Xlooop' },
          subject,
          html,
          text,
        });
        return { delivered: true, channel: 'cloudflare' };
      } catch (err) {
        lastError = formatErr('cloudflare', err);
        console.log(JSON.stringify({ kind: logKind, channel: 'cloudflare', error: lastError }));
      }
    }

    // 2. Resend — optional backup (dormant unless all three present).
    if (env.RESEND_API_KEY && env.RESEND_FROM_EMAIL && to.length > 0) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to, subject, html, text }),
        });
        if (res.ok) return { delivered: true, channel: 'resend' };
        lastError = `resend ${res.status}: ${(await res.text()).slice(0, 200)}`;
        console.log(JSON.stringify({ kind: logKind, channel: 'resend', error: lastError }));
      } catch (err) {
        lastError = formatErr('resend', err);
        console.log(JSON.stringify({ kind: logKind, channel: 'resend', error: lastError }));
      }
    }
  } catch (err) {
    // Unexpected (e.g. a render failure) — log and fall through to console. Never rethrow.
    lastError = formatErr('render', err);
    console.log(JSON.stringify({ kind: logKind, channel: 'render', error: lastError }));
  }

  // 3. Console — last resort. Already logged above; the caller is never blocked.
  return { delivered: true, channel: 'console', ...(lastError ? { error: lastError } : {}) };
}

function formatErr(channel: string, err: unknown): string {
  const e = err as { code?: string; message?: string };
  return `${channel}: ${e.code ? e.code + ' ' : ''}${e.message || String(err)}`.slice(0, 300);
}

function escapeHtml(s: unknown): string {
  // Coerce defensively — payload fields (e.g. a Date created_at) may not be strings, and a throw
  // here would propagate out of the notifier and 500 the caller.
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch] || ch));
}

function renderAccessRequestEmail(p: AccessRequestNotification): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial; max-width: 640px; margin: 0 auto;">
      <h2 style="color: #111;">New Xlooop access request</h2>
      <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
        <tr><td style="padding: 8px; border: 1px solid #eee;"><b>Email</b></td><td style="padding: 8px; border: 1px solid #eee;">${escapeHtml(p.email)}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #eee;"><b>Company</b></td><td style="padding: 8px; border: 1px solid #eee;">${escapeHtml(p.company_name || '—')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #eee;"><b>Account type</b></td><td style="padding: 8px; border: 1px solid #eee;">${escapeHtml(p.account_type || '—')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #eee;"><b>Registered?</b></td><td style="padding: 8px; border: 1px solid #eee;">${p.registered === false ? '<b style="color:#b45309;">NO — anonymous website lead</b>' : p.registered ? 'yes' : '—'}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #eee;"><b>Readiness</b></td><td style="padding: 8px; border: 1px solid #eee;">${p.deep_level != null ? 'Level ' + escapeHtml(String(p.deep_level)) : '—'}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #eee;"><b>Reason</b></td><td style="padding: 8px; border: 1px solid #eee;">${escapeHtml(p.reason || '—')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #eee;"><b>Source</b></td><td style="padding: 8px; border: 1px solid #eee;">${escapeHtml(p.source || '—')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #eee;"><b>IP</b></td><td style="padding: 8px; border: 1px solid #eee;">${escapeHtml(p.ip_address || '—')}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #eee;"><b>Request ID</b></td><td style="padding: 8px; border: 1px solid #eee;"><code>${escapeHtml(p.request_id)}</code></td></tr>
        <tr><td style="padding: 8px; border: 1px solid #eee;"><b>Received</b></td><td style="padding: 8px; border: 1px solid #eee;">${escapeHtml(p.created_at)}</td></tr>
      </table>
      <p style="color: #666; font-size: 13px;">
        Approve or reject in the admin CLI:
        <br><code style="display:inline-block; margin-top:4px; padding:4px 8px; background:#f4f4f4; border-radius:4px;">npm run admin:approve ${escapeHtml(p.request_id)}</code>
      </p>
    </div>
  `;
}

function renderAccessRequestText(p: AccessRequestNotification): string {
  return [
    'New Xlooop access request',
    '',
    `Email:        ${p.email}`,
    `Company:      ${p.company_name || '-'}`,
    `Account type: ${p.account_type || '-'}`,
    `Registered:   ${p.registered === false ? 'NO - anonymous website lead' : p.registered ? 'yes' : '-'}`,
    `Readiness:    ${p.deep_level != null ? 'Level ' + p.deep_level : '-'}`,
    `Reason:       ${p.reason || '-'}`,
    `Source:       ${p.source || '-'}`,
    `IP:           ${p.ip_address || '-'}`,
    `Request ID:   ${p.request_id}`,
    `Received:     ${p.created_at}`,
    '',
    `Approve: npm run admin:approve ${p.request_id}`,
  ].join('\n');
}

function renderCustomerApprovedEmail(p: CustomerApprovedNotification): string {
  const appUrl = p.app_url || 'https://app.xlooop.com';
  const who = p.company_name ? ` for ${escapeHtml(p.company_name)}` : '';
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial; max-width: 560px; margin: 0 auto; color: #111;">
      <h2 style="color: #111;">You're approved — welcome to Xlooop</h2>
      <p style="font-size: 15px; line-height: 1.6;">
        Good news — your request to access Xlooop${who} has been approved.
      </p>
      <p style="font-size: 15px; line-height: 1.6;">
        We're setting up your workspace now. You'll receive a separate email with a secure sign-in link
        to finish setup — usually within one business day. Your readiness answers and day-1 roadmap carry over.
      </p>
      <p style="font-size: 15px; line-height: 1.6;">
        You'll sign in at <a href="${escapeHtml(appUrl)}" style="color: #2563eb;">${escapeHtml(appUrl)}</a> once your link arrives.
      </p>
      <p style="font-size: 13px; color: #666;">Questions? Just reply to this email.</p>
      <p style="font-size: 13px; color: #666;">— The Xlooop team</p>
    </div>
  `;
}

function renderCustomerApprovedText(p: CustomerApprovedNotification): string {
  const appUrl = p.app_url || 'https://app.xlooop.com';
  const who = p.company_name ? ` for ${p.company_name}` : '';
  return [
    "You're approved — welcome to Xlooop",
    '',
    `Good news — your request to access Xlooop${who} has been approved.`,
    '',
    "We're setting up your workspace now. You'll receive a separate email with a secure",
    "sign-in link to finish setup — usually within one business day. Your readiness answers",
    'and day-1 roadmap carry over.',
    '',
    `You'll sign in at ${appUrl} once your link arrives.`,
    '',
    'Questions? Just reply to this email.',
    '— The Xlooop team',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// OS-5 W2 · digest-posted notification — the delivery rung of the approval loop (J2's missing last
// step: approve flipped approval_state and the digest went NOWHERE). Sent best-effort from the
// sign-offs route AFTER the proposal is atomically claimed completed. Same never-throws sendVia
// ladder; recipient = the operator's admin address (same trust level as access-request mail).

export interface DigestPostedNotification {
  workspace_id: string;
  summary: string;
  body: string;
}

export async function notifyDigestPosted(
  env: NotifierEnv,
  payload: DigestPostedNotification
): Promise<NotifyResult> {
  const recipients = (env.ADMIN_NOTIFICATION_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(
    JSON.stringify({
      kind: 'digest_notification',
      type: 'digest_posted',
      workspace_id: payload.workspace_id,
      recipients: recipients.length > 0 ? recipients : ['<no ADMIN_NOTIFICATION_EMAIL configured>'],
      env: env.ENVIRONMENT,
      timestamp: new Date().toISOString(),
    })
  );

  return sendVia(
    env,
    recipients,
    `[Xlooop] Digest posted — ${payload.workspace_id}`,
    () => renderDigestPostedEmail(payload),
    () => renderDigestPostedText(payload),
    'digest_notification_error'
  );
}

function renderDigestPostedEmail(p: DigestPostedNotification): string {
  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 620px;">
      <h2 style="margin: 0 0 4px;">Digest posted</h2>
      <p style="color: #555; margin: 0 0 14px;">Workspace <b>${escapeHtml(p.workspace_id)}</b> · approved by you, now the official record.</p>
      <p style="font-weight: 600; margin: 0 0 8px;">${escapeHtml(p.summary)}</p>
      <pre style="white-space: pre-wrap; background: #f6f7f9; border: 1px solid #eee; border-radius: 8px; padding: 12px; font: 13px/1.5 ui-monospace, monospace;">${escapeHtml(p.body)}</pre>
    </div>`;
}

function renderDigestPostedText(p: DigestPostedNotification): string {
  return [
    `Digest posted — workspace ${p.workspace_id}`,
    '',
    p.summary,
    '',
    p.body,
  ].join('\n');
}
