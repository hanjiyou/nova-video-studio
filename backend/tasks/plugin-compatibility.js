'use strict';
const ID = 'plugin:opensosen-video', CURRENT = '1.1.0', LEGACY = '1.0.0';
const oldModes = new Set(['video.text', 'video.single_reference', 'video.dual_reference']);
const legacySnapshot = snapshot => snapshot?.adapterId === ID && snapshot.adapterVersion === LEGACY && oldModes.has(snapshot.mode);
function legacyImageSnapshot(snapshot) {
    return snapshot?.adapterId === 'opensosen-flare-image' && snapshot.adapterVersion === '1.0.0' && snapshot.mode === 'image.text' &&
        snapshot.model === 'gpt-image-2.5-flare' && snapshot.parameters && Object.keys(snapshot.parameters).length === 0 &&
        Array.isArray(snapshot.inputAssets) && snapshot.inputAssets.length === 0;
}
function compatibleImageVersion(task) {
    if (task.adapter_id !== 'opensosen-flare-image') return null;
    if (task.adapter_version === '1.1.0') return '1.1.0';
    let snapshot; try { snapshot = JSON.parse(task.input_snapshot_json); } catch { return null; }
    return task.adapter_version === '1.0.0' && task.mode === snapshot.mode && legacyImageSnapshot(snapshot) ? '1.0.0' : null;
}
function replaySnapshot(candidate, saved) {
    if (candidate.adapterId === 'opensosen-flare-image' && candidate.adapterVersion === '1.1.0' && legacyImageSnapshot(saved)) return { ...candidate, adapterVersion: '1.0.0' };
    // Compare the caller's replay against its original adapter version; never edit saved bytes.
    return candidate.adapterId === ID && candidate.adapterVersion === CURRENT && candidate.mode === saved?.mode && legacySnapshot(saved) ? { ...candidate, adapterVersion: LEGACY } : candidate;
}
function compatiblePlugin(plugin, task) {
    if (!plugin || plugin.id !== 'opensosen-video' || task.adapter_version === plugin.manifest.version) return plugin;
    let snapshot; try { snapshot = JSON.parse(task.input_snapshot_json || '{}'); } catch { return null; }
    if (plugin.manifest.version !== CURRENT || task.adapter_id !== ID || task.adapter_version !== LEGACY || task.mode !== snapshot.mode || !legacySnapshot(snapshot)) return null;
    return { ...plugin, manifest: { ...plugin.manifest, version: LEGACY } };
}
module.exports = { replaySnapshot, compatiblePlugin, compatibleImageVersion };
