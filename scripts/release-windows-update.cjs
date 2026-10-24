'use strict';
// Release operator only. No credential is read until an explicit remote phase.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { verifyDirectory, hashFile, readPolicy, REPOSITORY } = require('./lib/windows-update.cjs');
const REPO = 'hanjiyou/nova-video-studio';
const API = `https://api.github.com/repos/${REPO}`;
const GATES = path.join(REPOSITORY, 'config/windows-update-release-gates.json');
class ReleaseError extends Error { }
function need(value, message) { if (!value) throw new ReleaseError(message); }
function args(argv) {
  const out = { phase: 'prepare', execute: false };
  const seen = new Set();
  const fields = new Map([['--directory', 'directory'], ['--phase', 'phase'], ['--notes-file', 'notesFile'], ['--commit', 'commit'], ['--release-id', 'releaseId'], ['--confirm-tag', 'confirmTag']]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute' && !out.execute) { out.execute = true; continue; }
    const key = fields.get(argv[i]);
    need(key && !seen.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--'), 'Unknown, missing or repeated release argument.');
    seen.add(key);
    out[key] = argv[++i];
  }
  need(out.directory && ['prepare', 'draft', 'upload', 'verify', 'publish'].includes(out.phase), 'Use --directory <build> [--phase prepare|draft|upload|verify|publish].');
  need(!out.releaseId || /^[1-9]\d*$/.test(out.releaseId), 'Release ID must be numeric.');
  need(!out.commit || /^[a-f0-9]{40}$/.test(out.commit), 'Commit must be a full Git SHA.');
  need(!out.execute || out.phase !== 'prepare', 'Prepare is always a local dry-run.');
  return out;
}
function blockers(plan, gates = JSON.parse(fs.readFileSync(GATES, 'utf8')), policy = readPolicy()) {
  const result = [];
  if (plan.profile !== 'release') result.push('Unsigned local-test artifacts cannot be uploaded or published.');
  if (plan.signature.mode !== 'authenticode' || policy.signing.status !== 'approved') result.push('Approved Authenticode publisher and valid installer/application signatures are required.');
  if (plan.runtimeReady !== true || policy.runtimeReady !== true) result.push('Release runtime metadata and policy must both be enabled after review.');
  need(gates.schemaVersion === 1 && gates.repository === REPO, 'Release gates repository/schema differs from the fixed feed.');
  for (const key of ['sourceAndLicenseDelivery', 'ffmpegCorrespondingSource', 't15RemainingModes', 'm5ReleaseAcceptance', 'isolatedInstalledUpdate']) {
    const gate = gates[key];
    if (!gate || gate.status !== 'complete' || typeof gate.evidence !== 'string' || !gate.evidence.trim()) result.push(`Pending release gate: ${key}.`);
  }
  return result;
}
async function localPreparation(options, deps = {}) {
  const directory = path.resolve(options.directory);
  const { plan, summary } = await (deps.verifyDirectory || verifyDirectory)(directory);
  const assets = [];
  for (const name of [plan.artifactName, plan.artifactName + '.blockmap', 'latest.yml']) {
    const file = path.join(directory, name);
    assets.push({ name, size: fs.statSync(file).size, sha512: await hashFile(file) });
  }
  return { plan, report: { schemaVersion: 1, repository: REPO, version: plan.version, tag: plan.tag, source: plan.source || null, phase: options.phase, dryRun: !options.execute, assets, signature: summary.signature, blockers: blockers(plan, deps.gates, deps.policy), retention: 'Keep all supported old exe/blockmap/release assets; never overwrite a tag, version or asset. Repair with a higher version.' } };
}
function github(token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Nova-Windows-Release' };
  return async (url, { method = 'GET', body, binary = false, missing = false } = {}) => {
    need(url.startsWith(API + '/') || url.startsWith(`https://uploads.github.com/repos/${REPO}/releases/`), 'Non-fixed GitHub endpoint rejected.');
    let response;
    try { response = await fetch(url, { method, headers: { ...headers, ...(binary ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) }, body: binary ? body : body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(120000) }); }
    catch { throw new ReleaseError('GitHub request failed; inspect the retained draft before retrying.'); }
    if (missing && response.status === 404) return null;
    need(response.ok, `GitHub ${method} failed (HTTP ${response.status}); existing draft/assets were retained.`);
    return response.json();
  };
}
async function remoteHash(assetId, token) {
  let url = `${API}/releases/assets/${assetId}`, authenticated = true;
  for (let redirects = 0; redirects < 6; redirects++) {
    let response;
    try { response = await fetch(url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'Nova-Windows-Release', ...(authenticated ? { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } : {}) }, redirect: 'manual', signal: AbortSignal.timeout(120000) }); }
    catch { throw new ReleaseError('Remote asset read failed; draft was retained.'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get('location'), url);
      need(next.protocol === 'https:' && !next.username && !next.password && (next.hostname.endsWith('.githubusercontent.com') || next.hostname === 'github.com' || next.hostname.endsWith('.github.com')), 'Unexpected GitHub asset redirect.');
      await response.body?.cancel();
      url = next.href; authenticated = false; continue;
    }
    need(response.ok && response.body, `Remote asset read failed (HTTP ${response.status}).`);
    const hash = createHash('sha512'); let size = 0;
    try { for await (const chunk of response.body) { size += chunk.length; hash.update(chunk); } }
    catch { throw new ReleaseError('Remote asset stream failed; draft was retained.'); }
    return { size, sha512: hash.digest('base64') };
  }
  throw new ReleaseError('Too many GitHub asset redirects.');
}
async function draftIdentity(request, id, report) {
  const release = await request(`${API}/releases/${id}`);
  need(release.draft === true && release.prerelease === false && release.tag_name === report.tag, 'Only the exact, unpublished stable draft may be verified/published.');
  need(report.source?.clean === true && release.target_commitish === report.source.commit, 'Draft target commit differs from the packaged clean source commit.');
  let ref = await request(`${API}/git/ref/tags/${report.tag}`, { missing: true });
  if (ref) {
    let object = ref.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = (await request(`${API}/git/tags/${object.sha}`)).object;
    need(object?.type === 'commit' && object.sha === report.source.commit, 'Existing tag does not resolve to the packaged source commit.');
  }
  return release;
}
async function verifyRemote(request, id, report, hashAsset) {
  const release = await draftIdentity(request, id, report);
  const assets = await request(`${API}/releases/${id}/assets?per_page=100`);
  need(Array.isArray(assets) && assets.length === report.assets.length, 'Draft assets are missing, extra or duplicated.');
  for (const expected of report.assets) {
    const matches = assets.filter(a => a.name === expected.name);
    need(matches.length === 1 && matches[0].state === 'uploaded' && matches[0].size === expected.size, 'Draft asset name/state/size differs.');
    const actual = await hashAsset(matches[0].id);
    need(actual.size === expected.size && actual.sha512 === expected.sha512, 'Remote asset bytes differ from the locally validated/signed artifacts.');
  }
  return release;
}
async function run(options, deps = {}) {
  const { plan, report } = await localPreparation(options, deps);
  if (!options.execute) return report;
  need(report.blockers.length === 0, report.blockers.join('\n'));
  need(['verify'].includes(options.phase) || options.confirmTag === report.tag, 'Explicit --confirm-tag must match the fixed build tag.');
  need(options.commit && options.commit === plan.source?.commit && plan.source.clean === true, '--commit must match the signed package clean source record.');
  need(options.phase === 'draft' || options.releaseId, 'verify/publish require --release-id from the retained draft.');
  const token = deps.remote?.token || process.env.NOVA_RELEASE_TOKEN;
  need(typeof token === 'string' && token.trim(), 'Future release operator must explicitly provide NOVA_RELEASE_TOKEN; no credential store is read.');
  const request = deps.remote?.request || github(token);
  const hashAsset = deps.remote?.hashAsset || (id => remoteHash(id, token));
  let id = options.releaseId;
  if (options.phase === 'draft') {
    need(options.commit && options.notesFile, 'Draft requires --commit <40-char SHA> and --notes-file <reviewed notes>.');
    const notes = fs.readFileSync(options.notesFile, 'utf8');
    need(notes.trim() && notes.length <= 100000, 'Reviewed release notes are missing or too large.');
    const repo = await request(`https://api.github.com/repos/${REPO}/`);
    need(repo.private === false && repo.full_name === REPO, 'Fixed public repository identity changed.');
    need(!await request(`${API}/git/ref/tags/${report.tag}`, { missing: true }), 'Tag already exists; use a new version.');
    for (let page = 1; ; page++) {
      need(page <= 100, 'Release history exceeds bounded inspection; review manually.');
      const releases = await request(`${API}/releases?per_page=100&page=${page}`);
      need(!releases.some(r => r.tag_name === report.tag), 'Same-version release/draft already exists; never overwrite it.');
      if (releases.length < 100) break;
    }
    await request(`${API}/git/commits/${options.commit}`);
    const draft = await request(`${API}/releases`, { method: 'POST', body: { tag_name: report.tag, target_commitish: options.commit, name: `Nova Studio ${plan.version}`, body: notes, draft: true, prerelease: false } });
    id = draft.id;
    console.log(`Draft ${id} created. A failure retains this draft; resume with --phase upload --release-id ${id}.`);
  }
  if (options.phase === 'draft' || options.phase === 'upload') {
    await draftIdentity(request, id, report);
    const assets = await request(`${API}/releases/${id}/assets?per_page=100`);
    need(assets.length <= report.assets.length && assets.every(a => report.assets.some(e => e.name === a.name)) && new Set(assets.map(a => a.name)).size === assets.length, 'Draft has unexpected or duplicate assets; no replacement is allowed.');
    // Verify every existing asset before writing even one missing asset.
    for (const existing of assets) {
      const expected = report.assets.find(a => a.name === existing.name), actual = await hashAsset(existing.id);
      need(existing.state === 'uploaded' && existing.size === expected.size && actual.size === expected.size && actual.sha512 === expected.sha512, 'Existing draft asset differs; stop and review, never overwrite it.');
    }
    for (const asset of report.assets.filter(a => !assets.some(e => e.name === a.name))) {
      await request(`https://uploads.github.com/repos/${REPO}/releases/${id}/assets?name=${encodeURIComponent(asset.name)}`, { method: 'POST', binary: true, body: fs.readFileSync(path.join(options.directory, asset.name)) });
    }
  }
  await verifyRemote(request, id, report, hashAsset);
  if (options.phase === 'publish') {
    const published = await request(`${API}/releases/${id}`, { method: 'PATCH', body: { draft: false, prerelease: false, make_latest: 'true' } });
    need(published.draft === false && published.tag_name === report.tag, 'Publication response did not confirm the expected release.');
  }
  return { ...report, dryRun: false, releaseId: id, remoteVerified: true, published: options.phase === 'publish' };
}
if (require.main === module) Promise.resolve().then(() => run(args(process.argv.slice(2)))).then(r => console.log(JSON.stringify(r, null, 2))).catch(error => { console.error('[FAILED] ' + (error instanceof ReleaseError ? error.message : 'Local artifact/config verification failed; run update:verify:win separately. Raw remote errors are never printed.')); process.exitCode = 1; });
module.exports = { args, blockers, localPreparation, run, draftIdentity, verifyRemote, ReleaseError };
