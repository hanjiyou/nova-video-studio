'use strict';
const { UUID, fail } = require('../storage/store');
const { containsCredential } = require('../connections/redaction');
const { MODEL, VERSION } = require('./flare-image-adapter');
const { controlledImageValidation } = require('./controlled-image-validation');
const { controlledVideoTextValidation } = require('./controlled-video-text-validation');
const { generationEvidenceVerified } = require('../connections/capabilities');
const videoPolicy = require('./video-policy');
const {videoRule,validParameters}=require('../connections/model-catalog');
const MODELS = require('../plugins/opensosen-video').MODELS;
const multiReference = require('./multi-reference-policy');
const imagePolicy = require('./image-policy');
const { MAX_VIDEO_REFERENCE_ASSETS } = require('../storage/application-limits');
const COUNTS = { 'image.text': [0,0], 'image.reference': [1,1], 'video.text': [0,0], 'video.single_reference': [1,1], 'video.dual_reference': [2,2], 'video.multi_reference': [3,MAX_VIDEO_REFERENCE_ASSETS] };
function invalid() { return fail('INPUT_INVALID', '模式、参数或有序素材引用无效。'); }
function snapshotFor(body, videoVersion) {
    const keys = ['localRequestId','connectionVersionId','capabilityVersionId','mode','model','prompt','parameters','inputAssets','outputDirectoryVersionId','outputRootRef','groupId','groupName','groupDirectoryVersionId'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw invalid();
    if (!Object.hasOwn(COUNTS, body.mode) || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 65536 ||
        !body.parameters || typeof body.parameters !== 'object' || Array.isArray(body.parameters) || !Array.isArray(body.inputAssets)) throw invalid();
    for (const key of ['localRequestId','connectionVersionId','capabilityVersionId','outputDirectoryVersionId','outputRootRef','groupId','groupDirectoryVersionId']) {
        if ((['localRequestId','connectionVersionId','capabilityVersionId'].includes(key) || body[key] !== undefined) &&
            (typeof body[key] !== 'string' || !UUID.test(body[key]))) throw invalid();
    }
    if (body.groupName !== undefined && (typeof body.groupName !== 'string' || body.groupName.length > 48)) throw invalid();
    if (body.mode === 'video.multi_reference' && videoVersion !== '1.1.0') throw invalid();
    const [min,max] = COUNTS[body.mode];
    if (body.inputAssets.length < min || body.inputAssets.length > max) throw invalid();
    const inputAssets = body.inputAssets.map((item,position) => {
        if (!item || item.position !== position || item.role !== 'reference' || typeof item.assetId !== 'string' || !UUID.test(item.assetId) ||
            Object.keys(item).some(key => !['position','role','assetId'].includes(key))) throw invalid();
        return {assetId:item.assetId.toLowerCase(),position,role:'reference'};
    });
    const image = body.mode.startsWith('image.');
    if (image ? body.model !== MODEL : !MODELS.includes(body.model)) throw invalid();
    if (image) {
        if (!imagePolicy.validParameters(body.parameters)) throw invalid();
    } else if (validParameters(videoRule(body.model,{provider:'opensosen',baseUrl:videoPolicy.RULES.baseUrl}),body.parameters)) {
        // The immutable capability version below distinguishes configured rules from legacy evidence.
    } else if (body.mode === 'video.text') {
        if (!controlledVideoTextValidation.allowsInput(body) && (body.parameters.seconds !== 6 || Object.keys(body.parameters).length !== 1)) throw invalid();
    } else if (Object.keys(body.parameters).some(key => !['seconds','size'].includes(key)) || body.parameters.seconds !== 6 || body.parameters.size !== '1280x720') throw invalid();
    return {contractVersion:1,localRequestId:body.localRequestId.toLowerCase(),connectionVersionId:body.connectionVersionId.toLowerCase(),
        capabilityVersionId:body.capabilityVersionId.toLowerCase(),mode:body.mode,model:body.model,prompt:body.prompt,
        parameters:{...body.parameters},inputAssets,adapterId:image?'opensosen-flare-image':'plugin:opensosen-video',adapterVersion:image?VERSION:videoVersion,
        ...(body.outputDirectoryVersionId?{outputDirectoryVersionId:body.outputDirectoryVersionId.toLowerCase()}:{}),
        ...(body.outputRootRef?{outputRootRef:body.outputRootRef.toLowerCase()}:{} ),
        ...(body.groupId?{groupId:body.groupId.toLowerCase()}:{}),
        ...(body.groupName!==undefined?{groupName:body.groupName}:{}),
        ...(body.groupDirectoryVersionId?{groupDirectoryVersionId:body.groupDirectoryVersionId.toLowerCase()}:{} )};
}
function validateCapability(db, snapshot, auth) {
    const capability = db.prepare('SELECT * FROM model_capabilities WHERE id=?').get(snapshot.capabilityVersionId);
    if (!capability || capability.provider !== auth.provider || capability.base_url !== auth.baseUrl ||
        capability.model !== snapshot.model || capability.mode !== snapshot.mode || capability.protocol !== auth.protocol) throw fail('CAPABILITY_UNVERIFIED','该能力版本与任务连接、模型或模式不匹配。');
    if (videoPolicy.matches(capability,snapshot,auth)) { if(!videoPolicy.allows(capability,snapshot,auth))throw fail('CAPABILITY_UNVERIFIED','此型号协议准备完成，仍待验证。'); return capability; }
    const controlledText = controlledVideoTextValidation.allows(snapshot, auth, capability);
    const unverifiedMulti = multiReference.allowsUnverifiedSubmission(capability, snapshot, auth);
    const unverifiedImage = imagePolicy.allowsUnverifiedSubmission(capability, snapshot, auth);
    if (!generationEvidenceVerified(capability) && !controlledImageValidation.allows(snapshot, auth, capability) && !controlledText && !unverifiedMulti && !unverifiedImage) throw fail('CAPABILITY_UNVERIFIED','当前组合尚未取得成功协议证据；保留需求，待受控验证。');
    const parameters = JSON.parse(capability.parameters_json);
    if (snapshot.mode.startsWith('image.') && !unverifiedImage && (snapshot.mode !== 'image.text' ||
        Object.keys(parameters).length || Object.keys(snapshot.parameters || {}).length || snapshot.inputAssets?.length)) throw invalid();
    if (snapshot.mode === 'video.text' && !controlledText && (parameters.encoding !== 'multipart' || parameters.referenceCount !== 0 ||
        parameters.seconds !== 6 || Object.keys(parameters).length !== 3 || snapshot.parameters.seconds !== 6 ||
        Object.keys(snapshot.parameters).length !== 1 || snapshot.inputAssets.length)) throw invalid();
    if (snapshot.mode === 'video.multi_reference' && (!unverifiedMulti || snapshot.parameters.seconds !== parameters.seconds || snapshot.parameters.size !== parameters.size)) throw invalid();
    if (snapshot.mode.startsWith('video.') && !['video.text','video.multi_reference'].includes(snapshot.mode) && !controlledText && (parameters.encoding !== 'multipart' || parameters.inputReferenceName !== 'input_reference' ||
        parameters.referenceCount !== snapshot.inputAssets.length || parameters.seconds !== snapshot.parameters.seconds || parameters.size !== snapshot.parameters.size)) throw invalid();
    return capability;
}
function validateInputs(snapshot, auth, store) {
    if (containsCredential(JSON.stringify(snapshot),auth.apiKey)) throw invalid();
    for (const input of snapshot.inputAssets) {
        const {asset,bytes} = store.readAsset(input.assetId);
        if (asset.kind !== 'image' || !['image/png','image/jpeg'].includes(asset.mimeType) || !bytes.length) throw invalid();
    }
}
module.exports = { snapshotFor, validateCapability, validateInputs };
