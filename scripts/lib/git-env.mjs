// WHY THIS EXISTS (the defect it closes · validated 260728):
//
// Git exports its per-invocation environment to hooks, and child processes inherit it.
// GIT_DIR OVERRIDES REPOSITORY DISCOVERY, so a `cwd`-scoped git call under an inherited
// GIT_DIR silently operates on the ENCLOSING repository instead. `cwd` is not a boundary.
//
// Measured consequence (commit db08f3e, 2026-07-28): with GIT_DIR set and GIT_WORK_TREE
// unset git adopts the child's cwd as the work tree, so
// verify-deployment-authorization-store.mjs added its tmpdir README.md to the enclosing
// repo's index and committed `test fixture` (author `Xlooop verifier <verifier@localhost>`)
// onto the branch being pushed — while the gate printed PASS and exited 0.
//
// `-C <dir>` does not help: it only changes directory, and GIT_DIR still wins over
// discovery. Explicit `--git-dir`/`--work-tree` would pin the repository but leave
// GIT_INDEX_FILE (observed as the RELATIVE value `.git/index`, re-resolved against every new
// cwd), GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES and GIT_QUARANTINE_PATH still
// steering the index and the object writes. Deleting the variables closes all of them at one
// site, and one shared list cannot drift the way a flag pair repeated at N call sites does.

/** Every per-invocation git variable that can override repository discovery, the index, or
 *  object writes. Inherited from a hook, any one of them makes `cwd` a lie. */
export const INHERITED_GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
];

/** `base` minus every inherited git-location variable. Pass the result as `env` to any
 *  child_process git call whose repository must be decided by `cwd` and nothing else. */
export function gitEnv(base = process.env) {
  const env = { ...base };
  for (const key of INHERITED_GIT_ENV_KEYS) delete env[key];
  return env;
}
