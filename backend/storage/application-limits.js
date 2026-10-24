'use strict';
// Packaged application resource policy, never a provider capability or a user-selected file.
const policy = require('./application-limits.json');
if (!Number.isInteger(policy.maxReferenceAssets) || policy.maxReferenceAssets < 3 || policy.maxReferenceAssets > 32) throw new Error('Invalid packaged reference limit (3..32).');
if (!Number.isInteger(policy.maxVideoReferenceAssets) || policy.maxVideoReferenceAssets < 3 || policy.maxVideoReferenceAssets > 7 || policy.maxVideoReferenceAssets > policy.maxReferenceAssets) throw new Error('Invalid packaged video reference limit (3..7).');
module.exports = { MAX_REFERENCE_ASSETS: policy.maxReferenceAssets, MAX_VIDEO_REFERENCE_ASSETS: policy.maxVideoReferenceAssets };
