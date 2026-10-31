import policy from '../../../backend/tasks/image-policy.json';
import type { CapabilitySummary, ConnectionSummary } from './connection-client';
export const IMAGE_QUALITY_LABELS: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
type ImageProfile = { modes: string[]; sizes: string[]; qualities: string[] };
type ImageModelConfig = { profile: string; submissionEnabled: boolean; modes?: string[]; sizes?: string[]; qualities?: string[] };
export function imageRule(model: string, connection?: Pick<ConnectionSummary, 'provider' | 'baseUrl' | 'protocol'> | null) {
  if (connection && (connection.provider !== policy.provider || connection.baseUrl !== policy.baseUrl || connection.protocol !== policy.protocol)) return null;
  const models: Record<string, ImageModelConfig> = policy.models, profiles: Record<string, ImageProfile> = policy.profiles;
  if (typeof model !== 'string' || !Object.hasOwn(models, model)) return null;
  const configured = models[model], profile = profiles[configured.profile];
  if (configured.profile !== 'openai-images-v1' || !profile) return null;
  const rule = { ...profile, ...configured, model };
  if (typeof rule.submissionEnabled !== 'boolean' || !Array.isArray(rule.modes) || rule.modes.some(mode => !['image.text', 'image.reference'].includes(mode)) ||
      !Array.isArray(rule.sizes) || !Array.isArray(rule.qualities) ||
      [...rule.sizes, ...rule.qualities].some(value => typeof value !== 'string' || !value || value.length > 64)) return null;
  return rule;
}
export function unverifiedImageCapability(capability: CapabilitySummary | undefined, connection: ConnectionSummary | null) {
  if (!capability || !connection) return false;
  const rule = imageRule(capability.model, connection), legacy = capability.evidenceVersion === policy.legacyEvidenceVersion;
  if (!rule || !rule.submissionEnabled || !rule.modes.includes(capability.mode) || capability.evidenceLevel !== 'unverified' ||
      ![policy.evidenceVersion, policy.legacyEvidenceVersion].includes(capability.evidenceVersion) ||
      capability.provider !== policy.provider || capability.baseUrl !== policy.baseUrl || capability.protocol !== policy.protocol ||
      legacy && capability.model !== policy.model) return false;
  const reference = capability.mode === 'image.reference', p = capability.parameters;
  const evidence = capability.evidence as typeof capability.evidence & { configuredProtocol?: string; submissionEnabled?: boolean };
  return Object.keys(p).length === (reference ? 5 : 4) && JSON.stringify(p.sizes) === JSON.stringify(legacy ? policy.sizes : rule.sizes) &&
    JSON.stringify(p.qualities) === JSON.stringify(legacy ? policy.qualities : rule.qualities) &&
    p.encoding === (reference ? 'multipart' : 'json') && p.referenceCount === (reference ? 1 : 0) && (!reference || p.inputReferenceName === 'image') &&
    capability.evidence.applicationVerified === false && capability.evidence.submissionPolicy === (legacy ? policy.legacySubmissionPolicy : policy.submissionPolicy) &&
    Array.isArray(capability.evidence.sourceIds) && capability.evidence.sourceIds.length === 0 &&
    (legacy || evidence.configuredProtocol === rule.profile && evidence.submissionEnabled === true);
}
