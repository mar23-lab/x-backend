# Commercial Operator-Gated Readiness

Xlooop can prepare and review a controlled commercial pilot without claiming
public/self-serve readiness.

Current stance:

- Controlled pilot: ready with restrictions.
- Private paid Operator mode: requires Marat onboarding decision and evidence.
- Watch/Test customer-feedback paths: allowed when customer-safe.
- Public/self-serve readiness: not claimed.
- XCP access: second-level entitlement; Xlooop access does not grant XCP.

Marat decides who is onboarded and when. Until that decision is recorded, private
Operator controls must stay disabled with the reason `Requires Marat onboarding
decision`.

The readiness gates should return `operator_gated` when implementation is safe
but awaiting Marat/evidence. They should return `fail` only when a bypass,
unsupported public claim, or contradictory runtime behavior exists.
