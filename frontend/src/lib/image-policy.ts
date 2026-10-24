import policy from '../../../backend/tasks/image-policy.json';
import type { CapabilitySummary, ConnectionSummary } from './connection-client';
export const IMAGE_QUALITY_LABELS: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
export function unverifiedImageCapability(capability: CapabilitySummary | undefined, connection: ConnectionSummary | null) {
  if (!capability || !connection || !['image.text','image.reference'].includes(capability.mode) || capability.evidenceLevel !== 'unverified' || capability.evidenceVersion !== policy.evidenceVersion ||
      capability.provider !== policy.provider || capability.baseUrl !== policy.baseUrl || capability.model !== policy.model || capability.protocol !== policy.protocol ||
      connection.provider !== policy.provider || connection.baseUrl !== policy.baseUrl || connection.protocol !== policy.protocol) return false;
  const reference = capability.mode === 'image.reference', p = capability.parameters;
  return Object.keys(p).length === (reference ? 5 : 4) && JSON.stringify(p.sizes) === JSON.stringify(policy.sizes) && JSON.stringify(p.qualities) === JSON.stringify(policy.qualities) &&
    p.encoding === (reference ? 'multipart' : 'json') && p.referenceCount === (reference ? 1 : 0) && (!reference || p.inputReferenceName === 'image') &&
    capability.evidence.applicationVerified === false && capability.evidence.submissionPolicy === policy.submissionPolicy && Array.isArray(capability.evidence.sourceIds) && capability.evidence.sourceIds.length === 0;
}
