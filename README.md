# x-backend

Shadow extraction of the Xlooop customer backend. This repository is independently buildable and
testable, but it is not production authority.

## Authority

- Production runtime and deploy authority: `Xlooop-XCP-demo`.
- Shadow source: this repository, copied from source commit recorded in
  `MIGRATION-PROVENANCE.json`.
- Frontend consumer: `x-ai-front`, through the versioned API contract only.
- Cross-repository documentation: `x-ai-docs`.
- Governance source: MB-P; MB-P is never a runtime filesystem dependency.

No command in this repository may deploy to the production worker, apply a migration, change a
feature flag, or claim canonical authority without Marat's separate explicit cutover approval.

## Local proof

```sh
nvm use
npm ci
npm run ci-local
npm run verify:bundle
```

`verify:bundle` is a local bundle proof only. It is not deployment evidence.
