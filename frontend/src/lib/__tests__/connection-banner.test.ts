import {describe,it,expect} from 'vitest';
import {connectionBanner,connectionMessage} from '../workbench-client';
import type {ConnectionSummary} from '../connection-client';
const saved={baseUrl:'https://fixture.invalid/v1',hasCredential:true,credentialState:'ready',validationState:'verified',lastCheckedAt:'2020-01-01T00:00:00Z'} as ConnectionSummary;
describe('workbench connection banner',()=>{
 it('does not suggest reconfiguration for old, successful, unchecked or model-list-only failures',()=>{for(const validationState of ['verified','unverified','models_unsupported','models_invalid','offline','unavailable'])expect(connectionBanner({...saved,validationState})).toBeNull();expect(connectionMessage(saved)).toContain('过期');});
 it('explains actionable missing credentials, unreadable keys, explicit auth denial and offline separately',()=>{expect(connectionBanner(null)).toContain('尚未配置');expect(connectionBanner({...saved,baseUrl:'invalid'})).toContain('地址无效');expect(connectionBanner({...saved,hasCredential:false})).toContain('Key');expect(connectionBanner({...saved,credentialState:'unavailable'})).toContain('解密');expect(connectionBanner({...saved,validationState:'auth_rejected'})).toContain('鉴权');expect(connectionBanner(saved,false)).toContain('无需重新填写');});
});
