import { customerSafeJson, healthPayload } from '../../_lib/customer-feedback-authority.js';

const ROUTE_SCHEMA = 'xlooop.customer_feedback_health.v1';
const REQUIRED_POSTURE_FIELDS = ['freshness_status', 'redaction_scan'];

export async function onRequestGet({ env, request }) {
  const payload = await healthPayload(env, request);
  payload.route_schema = ROUTE_SCHEMA;
  payload.required_posture_fields = REQUIRED_POSTURE_FIELDS;
  return customerSafeJson(payload, payload.status === 'pass' ? 200 : 503);
}
