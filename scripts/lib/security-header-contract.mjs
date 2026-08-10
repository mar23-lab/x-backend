const PRODUCTION_API_ORIGIN = 'https://api.xlooop.com';

export function resolvePagesSecurityHeaderManifest(manifest, apiBase = PRODUCTION_API_ORIGIN) {
  const headers = manifest?.global_headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('security header manifest must declare global_headers');
  }

  let apiOrigin;
  try {
    const parsed = new URL(apiBase);
    if (parsed.protocol !== 'https:') throw new Error('non-HTTPS origin');
    apiOrigin = parsed.origin;
  } catch {
    throw new Error('security header API base must be an absolute HTTPS URL');
  }

  const effective = JSON.parse(JSON.stringify(manifest));
  const csp = String(effective.global_headers['Content-Security-Policy'] || '');
  const directives = csp.split(';').map((part) => part.trim()).filter(Boolean);
  const connectIndex = directives.findIndex((part) => part.startsWith('connect-src '));
  if (connectIndex < 0) throw new Error('security header CSP must declare connect-src');

  const connectParts = directives[connectIndex].split(/\s+/);
  if (!connectParts.includes(PRODUCTION_API_ORIGIN)) {
    throw new Error(`security header CSP connect-src must declare ${PRODUCTION_API_ORIGIN}`);
  }
  if (apiOrigin === PRODUCTION_API_ORIGIN) return effective;
  directives[connectIndex] = connectParts
    .map((part) => part === PRODUCTION_API_ORIGIN ? apiOrigin : part)
    .join(' ');
  effective.global_headers['Content-Security-Policy'] = `${directives.join('; ')};`;
  return effective;
}

export function rewritePagesWorkerSecurityHeaders(workerBundle, sourceManifest, effectiveManifest) {
  let rewritten = workerBundle;
  for (const [name, sourceValue] of Object.entries(sourceManifest?.global_headers || {})) {
    const effectiveValue = effectiveManifest?.global_headers?.[name];
    if (typeof effectiveValue !== 'string' || sourceValue === effectiveValue) continue;
    const occurrences = rewritten.split(String(sourceValue)).length - 1;
    if (occurrences < 1) {
      throw new Error(`Pages Functions bundle is missing the source ${name} value`);
    }
    rewritten = rewritten.split(String(sourceValue)).join(effectiveValue);
  }
  return rewritten;
}

export function renderPagesHeaders(manifest) {
  const headers = manifest?.global_headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('security header manifest must declare global_headers');
  }
  const lines = ['/*'];
  for (const [name, value] of Object.entries(headers)) lines.push(`  ${name}: ${value}`);
  for (const override of manifest.path_overrides || []) {
    lines.push('', String(override.match));
    for (const [name, value] of Object.entries(override.headers || {})) {
      lines.push(`  ${name}: ${value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
