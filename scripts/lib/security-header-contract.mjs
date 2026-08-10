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
