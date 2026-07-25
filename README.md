# x-backend

Production source for the Xlooop customer backend. This repository is independently buildable and
testable; deployment remains an explicit operator-gated operation.

## Authority

- Production API source and deploy authority: this repository.
- Deployed runtime truth: the exact build, schema, contract, environment, authority, and feature
  posture returned by `GET /api/v1/health`.
- Donor provenance: the original extraction source is recorded in `MIGRATION-PROVENANCE.json`;
  later accepted changes are recorded append-only in `MIGRATION-DELTA-PROVENANCE.json`.
- Frontend consumer: `x-ai-front`, through the versioned API contract only.
- Cross-repository documentation: `x-ai-docs`.
- Governance source: MB-P; MB-P is never a runtime filesystem dependency.

No command in this repository may deploy to the production worker, apply a migration, change a
feature flag, or claim release completion without Marat's current explicit approval naming the
exact operation and target.

## Latest accepted mirror

The packet lifecycle, typed relationship, and advisory action-intent contracts are mirrored from
Xlooop runtime merge
[`edc0805a`](https://github.com/mar23-lab/Xlooop-XCP-demo/commit/edc0805ae80a6006066c048985a3cc8d86ae0a21).
Migrations 073/074 remain staged, runtime flags remain default-off, and this mirror is not
deployment, migration-application, feature-enablement, or cutover evidence.

## Local proof

```sh
nvm use
npm run bootstrap:local
npm run ci-local
npm run verify:bundle
```

`bootstrap:local` installs both independently locked dependency trees: the Worker backend and
`packages/xlooop-mcp-server`.

`verify:bundle` is a local bundle proof only. It is not deployment evidence.
