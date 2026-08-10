import {
  HASH_PATTERN,
  SHA_PATTERN,
  UUID_PATTERN,
  posturesEqual,
  releaseManifestDigest,
} from './app-pages-release-contract.mjs';

function sameExpectedDeployment(left, right) {
  return left?.contract_hash === right?.contract_hash
    && left?.schema_head === right?.schema_head
    && left?.environment === right?.environment
    && left?.authority === right?.authority
    && posturesEqual(left?.feature_posture, right?.feature_posture);
}

export function assessPairedCutoverContract(apiPacket, pagesPacket, manifest, backendHead) {
  const problems = [];
  const cutoverId = apiPacket?.cutover_id;
  const apiExpected = apiPacket?.expected_deployment;
  const pagesExpected = pagesPacket?.expected_deployment;
  const paired = apiPacket?.paired_frontend_release;

  if (!UUID_PATTERN.test(cutoverId || '')) problems.push('api_cutover_id');
  if (!UUID_PATTERN.test(pagesPacket?.cutover_id || '')) problems.push('pages_cutover_id');
  if (cutoverId !== pagesPacket?.cutover_id) problems.push('cutover_id_mismatch');
  if (!SHA_PATTERN.test(backendHead || '')) problems.push('backend_head');
  if (apiPacket?.candidate_commit_sha !== backendHead) problems.push('api_candidate_not_head');
  if (pagesPacket?.candidate?.backend_sha !== backendHead) problems.push('pages_backend_not_head');
  if (manifest?.backend_sha !== backendHead) problems.push('manifest_backend_not_head');
  if (pagesPacket?.candidate?.frontend_sha !== manifest?.frontend_sha) {
    problems.push('pages_frontend_manifest_mismatch');
  }
  if (apiExpected?.build_sha !== backendHead) problems.push('api_expected_build');
  if (!sameExpectedDeployment(apiExpected, pagesExpected)) problems.push('expected_deployment_mismatch');
  if (manifest?.contract_hash !== apiExpected?.contract_hash) problems.push('manifest_contract_hash');
  if (manifest?.schema_head !== apiExpected?.schema_head) problems.push('manifest_schema_head');
  if (manifest?.environment !== apiExpected?.environment) problems.push('manifest_environment');
  if (manifest?.authority !== apiExpected?.authority) problems.push('manifest_authority');
  if (!posturesEqual(manifest?.feature_posture, apiExpected?.feature_posture)) {
    problems.push('manifest_feature_posture');
  }
  if (!HASH_PATTERN.test(manifest?.artifact_digest || '')
    || manifest.artifact_digest !== releaseManifestDigest(manifest)) {
    problems.push('manifest_artifact_digest');
  }
  if (pagesExpected?.artifact_digest !== manifest?.artifact_digest) {
    problems.push('pages_artifact_digest');
  }
  if (pagesExpected?.artifact_contract !== manifest?.artifact_contract) {
    problems.push('pages_artifact_contract');
  }
  if (paired?.artifact_digest !== manifest?.artifact_digest) problems.push('api_artifact_digest');
  if (paired?.artifact_contract !== manifest?.artifact_contract) problems.push('api_artifact_contract');
  if (paired?.frontend_sha !== manifest?.frontend_sha) problems.push('api_frontend_sha');
  if (paired?.backend_sha !== manifest?.backend_sha) problems.push('api_frontend_backend_sha');
  if (paired?.contract_hash !== manifest?.contract_hash) problems.push('api_frontend_contract_hash');
  if (paired?.schema_head !== manifest?.schema_head) problems.push('api_frontend_schema_head');
  if (!posturesEqual(paired?.feature_posture, manifest?.feature_posture)) {
    problems.push('api_frontend_feature_posture');
  }
  if (pagesPacket?.rollback?.backend_sha !== apiPacket?.rollback?.target_sha) {
    problems.push('rollback_backend_pair_mismatch');
  }
  if (apiPacket?.decision?.approver !== pagesPacket?.decision?.approver) {
    problems.push('approver_mismatch');
  }
  if (apiPacket?.decision?.approval_reference !== pagesPacket?.decision?.approval_reference) {
    problems.push('approval_reference_mismatch');
  }

  return { ok: problems.length === 0, problems, cutover_id: cutoverId || null };
}

export async function executeCompensatingCutover(steps) {
  let apiMutationAttempted = false;
  let pagesMutationAttempted = false;
  try {
    await steps.preflight();
    await steps.reserveAuthorizations();
    apiMutationAttempted = true;
    await steps.deployApi();
    await steps.ratifyApi();
    pagesMutationAttempted = true;
    await steps.deployPages();
    await steps.ratifyPair();
    return { status: 'ratified', rollback: [] };
  } catch (error) {
    const rollback = [];
    if (pagesMutationAttempted) {
      try {
        await steps.rollbackPages();
        rollback.push({ surface: 'pages', status: 'restored' });
      } catch (rollbackError) {
        rollback.push({ surface: 'pages', status: 'failed', error: String(rollbackError) });
      }
    }
    if (apiMutationAttempted) {
      try {
        await steps.rollbackApi();
        rollback.push({ surface: 'api', status: 'restored' });
      } catch (rollbackError) {
        rollback.push({ surface: 'api', status: 'failed', error: String(rollbackError) });
      }
    }
    const failedRollback = rollback.filter((item) => item.status !== 'restored');
    const failure = new Error(
      failedRollback.length
        ? `paired cutover failed and rollback was incomplete: ${String(error)}`
        : `paired cutover failed and the prior pair was restored: ${String(error)}`,
    );
    failure.cause = error;
    failure.rollback = rollback;
    throw failure;
  }
}
