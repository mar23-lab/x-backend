// functions/oauth/consent.js · Stage-2 second half (260806) · the OAuth consent page.
//
// Served on app.xlooop.com (the Pages plane) so the operator's Clerk session is FIRST-PARTY —
// the api-origin authorize endpoint 302s here after validating client_id + redirect_uri. This page
// renders the decision, obtains a session JWT via Clerk JS (clerk.xlooop.com, first-party allowed
// origin), and POSTs the decision to the API's Clerk-gated /oauth/consent, which is the ONLY place
// a grant code is minted (this page holds no secrets and makes no authorization decisions).
// Deny short-circuits straight back to the client per RFC 6749 (error=access_denied).
//
// The publishable key is public by definition (pk_live_… ships in every page of the app).

const CLERK_PK = 'pk_live_Y2xlcmsueGxvb29wLmNvbSQ';
const CLERK_JS = 'https://clerk.xlooop.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
const API_CONSENT = 'https://api.xlooop.com/oauth/consent';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const q = (k) => url.searchParams.get(k) || '';
  const params = {
    client_id: q('client_id'),
    redirect_uri: q('redirect_uri'),
    state: q('state'),
    code_challenge: q('code_challenge'),
    code_challenge_method: q('code_challenge_method'),
    scope: q('scope'),
  };
  if (!params.client_id || !params.redirect_uri || !params.code_challenge) {
    return new Response('Missing OAuth parameters. Start again from your MCP client.', { status: 400, headers: { 'content-type': 'text/plain' } });
  }
  let clientHost = 'the connecting application';
  try { clientHost = new URL(params.redirect_uri).hostname || clientHost; } catch { /* display only */ }
  const wantsOperator = params.scope === 'operator';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize connector · Xlooop</title>
<style>
  body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f5f2;color:#1c1b18;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#fff;border:1px solid #e3e0d8;border-radius:12px;max-width:420px;width:92%;padding:28px 26px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
  h1{font-size:17px;margin:0 0 10px} p{margin:8px 0;color:#4c493f} .who{font-size:13px;color:#807b6d;min-height:18px}
  .grant{background:#faf9f5;border:1px solid #eceade;border-radius:8px;padding:10px 12px;margin:14px 0;font-size:13.5px}
  .row{display:flex;gap:10px;margin-top:18px}
  button{flex:1;padding:10px 0;border-radius:8px;border:1px solid #d8d4c8;font-size:14.5px;cursor:pointer;background:#fff}
  #approve{background:#1c1b18;color:#fff;border-color:#1c1b18} #approve:disabled{opacity:.45;cursor:default}
  .err{color:#a03d2e;font-size:13px;min-height:16px;margin-top:10px}
</style></head><body><div class="card">
  <h1>Authorize a connector for Xlooop</h1>
  <p><strong>${esc(clientHost)}</strong> is requesting a connector token for your workspace.</p>
  <div class="grant">Access level: <strong>${wantsOperator ? 'Operational — the agent may REPORT work (evidence, tool events, approval requests). It can never sign off, approve, or delete.' : 'Read-only — tenant-scoped reads only.'}</strong><br>Valid 90 days · revocable any time in Settings → Developer access.</div>
  <p class="who" id="who">Checking your session…</p>
  <div class="row"><button id="deny">Deny</button><button id="approve" disabled>Approve</button></div>
  <p class="err" id="err"></p>
</div>
<script>
  const P = ${JSON.stringify(params)};
  const err = (m) => { document.getElementById('err').textContent = m; };
  document.getElementById('deny').onclick = () => {
    try {
      const u = new URL(P.redirect_uri);
      u.searchParams.set('error', 'access_denied');
      if (P.state) u.searchParams.set('state', P.state);
      location.href = u.toString();
    } catch (_) { err('Could not return to the client.'); }
  };
  const s = document.createElement('script');
  s.src = ${JSON.stringify(CLERK_JS)};
  s.setAttribute('data-clerk-publishable-key', ${JSON.stringify(CLERK_PK)});
  s.async = true; s.crossOrigin = 'anonymous';
  s.onload = async () => {
    try {
      await window.Clerk.load();
      if (!window.Clerk.session) {
        document.getElementById('who').textContent = 'Sign in to continue.';
        window.Clerk.openSignIn({ redirectUrl: location.href });
        return;
      }
      const email = (window.Clerk.user && window.Clerk.user.primaryEmailAddress && window.Clerk.user.primaryEmailAddress.emailAddress) || 'your account';
      document.getElementById('who').textContent = 'Signed in as ' + email;
      const btn = document.getElementById('approve');
      btn.disabled = false;
      btn.onclick = async () => {
        btn.disabled = true; err('');
        try {
          const token = await window.Clerk.session.getToken({ template: 'xlooop-workers' });
          const res = await fetch(${JSON.stringify(API_CONSENT)}, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
            body: JSON.stringify(P),
          });
          const j = await res.json().catch(() => ({}));
          if (res.ok && j.redirect_to) { location.href = j.redirect_to; return; }
          err(j.error_description || j.error || ('Consent failed (' + res.status + ').'));
          btn.disabled = false;
        } catch (e) { err('Consent failed: ' + (e && e.message || e)); btn.disabled = false; }
      };
    } catch (e) { err('Could not load your session: ' + (e && e.message || e)); }
  };
  s.onerror = () => err('Could not load the sign-in library.');
  document.head.appendChild(s);
</script></body></html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
