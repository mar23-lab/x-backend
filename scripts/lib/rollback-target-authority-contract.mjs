function valuesForKey(value, wanted, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) valuesForKey(item, wanted, found);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (wanted.includes(key) && (typeof child === 'string' || typeof child === 'number')) {
      found.push(String(child));
    }
    if (key === 'name' && child === 'BUILD_SHA') {
      for (const candidate of ['text', 'value', 'plain_text']) {
        if (typeof value[candidate] === 'string') found.push(value[candidate]);
      }
    }
    valuesForKey(child, wanted, found);
  }
  return found;
}

export function rollbackAuthorityValues(value, wanted) {
  return valuesForKey(value, wanted);
}

export function pagesSourceMatches(observed, expected) {
  if (typeof observed !== 'string' || typeof expected !== 'string') return false;
  const source = observed.trim().toLowerCase();
  const target = expected.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(source) || !/^[0-9a-f]{40}$/.test(target)) return false;
  return source === target || target.startsWith(source);
}

export function assessRollbackAuthorityEvidence(workerVersion, pagesDeployments, expected) {
  const problems = [];
  const workerIds = valuesForKey(workerVersion, ['id', 'version_id']);
  const workerShas = valuesForKey(workerVersion, ['BUILD_SHA', 'build_sha']);
  if (!workerIds.includes(expected.worker_version_id)) problems.push('worker_version_id');
  if (!workerShas.includes(expected.backend_sha)) problems.push('worker_version_backend_sha');

  const rows = Array.isArray(pagesDeployments)
    ? pagesDeployments
    : Array.isArray(pagesDeployments?.result) ? pagesDeployments.result : [];
  const pages = rows.find((row) => valuesForKey(row, ['id', 'deployment_id', 'Id'])
    .includes(expected.pages_deployment_id));
  if (!pages) problems.push('pages_deployment_id');
  else {
    const commits = valuesForKey(pages, ['commit_hash', 'commitHash', 'Source']);
    if (!commits.some((commit) => pagesSourceMatches(commit, expected.frontend_sha))) {
      problems.push('pages_deployment_frontend_sha');
    }
  }
  return { ok: problems.length === 0, problems, pages: pages || null };
}
