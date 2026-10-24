import limits from '../../../backend/storage/application-limits.json';
import multi from '../../../backend/tasks/multi-reference-policy.json';
import type { CapabilitySummary, ConnectionSummary } from './connection-client';
export const MAX_REFERENCE_ASSETS = limits.maxReferenceAssets;
if (!Number.isInteger(MAX_REFERENCE_ASSETS) || MAX_REFERENCE_ASSETS < 3 || MAX_REFERENCE_ASSETS > 32) throw Error('Invalid packaged reference limit (3..32).');
export const MAX_VIDEO_REFERENCE_ASSETS = limits.maxVideoReferenceAssets;
if (!Number.isInteger(MAX_VIDEO_REFERENCE_ASSETS) || MAX_VIDEO_REFERENCE_ASSETS < 3 || MAX_VIDEO_REFERENCE_ASSETS > 7 || MAX_VIDEO_REFERENCE_ASSETS > MAX_REFERENCE_ASSETS) throw Error('Invalid packaged video reference limit (3..7).');
export function unverifiedMultiSubmissionAllowed(capability: CapabilitySummary | undefined, connection: ConnectionSummary | null) {
  if (!capability || !connection || capability.evidenceLevel !== 'unverified' || capability.evidenceVersion !== multi.evidenceVersion ||
      capability.provider !== multi.provider || capability.baseUrl !== multi.baseUrl || capability.model !== multi.model || capability.mode !== multi.mode || capability.protocol !== multi.protocol ||
      connection.provider !== multi.provider || connection.baseUrl !== multi.baseUrl || connection.protocol !== multi.protocol) return false;
  const p = capability.parameters;
  return Object.keys(p).length === 5 && p.seconds === multi.seconds && p.size === multi.size && p.encoding === 'multipart' && p.inputReferenceName === 'input_reference' && p.minimumReferences === multi.minimumReferences &&
    capability.evidence.applicationVerified === false && capability.evidence.submissionPolicy === 'explicit-user-action-unverified-multi-reference-v1' && capability.evidence.supplierMaximumReferences === null && Array.isArray(capability.evidence.sourceIds) && capability.evidence.sourceIds.length === 0;
}
