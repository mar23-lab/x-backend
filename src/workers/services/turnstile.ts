// turnstile.ts · Cloudflare Turnstile server-side verification (R56 Stage 1).
//
// "Wire now, provision after": verification is GATED on TURNSTILE_SECRET.
//   - secret UNSET (pre-provisioning)  -> { ok: true, skipped: true }  (funnel keeps working)
//   - secret SET, token missing/invalid -> { ok: false }               (caller returns 403)
//   - secret SET, token valid           -> { ok: true }
//   - siteverify network error          -> { ok: true, skipped: true } (fail OPEN; the per-IP
//                                            rate-limit still backstops abuse, and a transient
//                                            Cloudflare outage must not block real signups)
//
// Operator: set the secret only AFTER the x-web Turnstile widget is live (else the funnel will
// 403 tokenless posts).  `wrangler secret put TURNSTILE_SECRET`

export interface TurnstileEnv {
  TURNSTILE_SECRET?: string;
}

export interface TurnstileResult {
  ok: boolean;
  skipped: boolean;
  reason?: 'missing_token' | 'verification_failed' | 'siteverify_unreachable';
}

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  env: TurnstileEnv,
  token: string | null | undefined,
  ip: string | null | undefined
): Promise<TurnstileResult> {
  const secret = env.TURNSTILE_SECRET;
  // Not provisioned yet -> do not block (wire-now phase).
  if (!secret) return { ok: true, skipped: true };

  if (!token || typeof token !== 'string') {
    return { ok: false, skipped: false, reason: 'missing_token' };
  }

  try {
    const form = new FormData();
    form.append('secret', secret);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    const resp = await fetch(SITEVERIFY_URL, { method: 'POST', body: form });
    const data = (await resp.json().catch(() => null)) as { success?: boolean } | null;
    if (data && data.success === true) return { ok: true, skipped: false };
    return { ok: false, skipped: false, reason: 'verification_failed' };
  } catch {
    // Network error reaching Cloudflare. Fail OPEN; rate-limit still applies.
    return { ok: true, skipped: true, reason: 'siteverify_unreachable' };
  }
}
