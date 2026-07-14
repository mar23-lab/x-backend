// functions/api/csp-report.js · CSP violation report collector.
//
// X-SCP P0.1 follow-on (egress-of-XSS-hardening, report-only -> enforce staging).
// The app CSP ships as Content-Security-Policy-Report-Only (data/security-headers.
// manifest.json) so a strict policy can be validated on real traffic before it
// blocks. Previously the policy named no collector, so violations went nowhere and
// the "review violations -> enforce" step could never happen. This endpoint is that
// collector: a pure sink that logs each violation to Workers Logs (P3 observability),
// so the operator can confirm zero legitimate-script breakage before dropping
// 'unsafe-inline' and flipping report-only -> enforce.
//
// No DB, no auth, no PII: CSP reports are browser-generated and contain only the
// violated directive + blocked/document URIs. Always 202 so browsers don't retry-storm.

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 202,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function onRequestPost({ request }) {
  let report = null;
  try {
    const raw = await request.text();
    report = raw ? JSON.parse(raw) : null;
  } catch {
    return json({ received: false, reason: 'unparseable' }, 202);
  }

  // Normalize the two wire formats:
  //   legacy report-uri : { "csp-report": { "violated-directive": ..., "blocked-uri": ... } }
  //   modern report-to  : [ { "type": "csp-violation", "body": { "effectiveDirective": ... } } ]
  let violations = [];
  if (Array.isArray(report)) {
    violations = report
      .filter((r) => r && (r.type === 'csp-violation' || r.body))
      .map((r) => r.body || r);
  } else if (report && report['csp-report']) {
    violations = [report['csp-report']];
  } else if (report) {
    violations = [report];
  }

  for (const v of violations) {
    console.log(
      JSON.stringify({
        kind: 'csp_violation',
        ts: new Date().toISOString(),
        effective_directive:
          v['effective-directive'] || v.effectiveDirective || v['violated-directive'] || v.violatedDirective || null,
        blocked_uri: v['blocked-uri'] || v.blockedURL || null,
        document_uri: v['document-uri'] || v.documentURL || null,
        source_file: v['source-file'] || v.sourceFile || null,
        disposition: v.disposition || 'report',
      })
    );
  }

  return json({ received: true, count: violations.length }, 202);
}

// CSP reports are POST-only; respond cheaply to anything else.
export function onRequestGet() {
  return json({ error: 'CSP violation reports are POST-only' }, 405);
}
