'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { failure, fileFailure } = require('./download-errors');
function createOutputDirectories({ db, defaultDirectory }) {
    // Existing roots remain authoritative, including an offline/removable directory.
    const DEFAULT = '00000000-0000-4000-8000-000000000001';
    if (!db.prepare('SELECT 1 FROM storage_roots WHERE id=?').get(DEFAULT)) {
        fs.mkdirSync(defaultDirectory, { recursive: true });
        db.transaction(() => {
            db.prepare('INSERT INTO storage_roots VALUES(?,?,?)').run(DEFAULT, fs.realpathSync.native(defaultDirectory), new Date().toISOString());
            db.prepare('INSERT INTO output_directory_versions VALUES(?,?,?)').run(DEFAULT, DEFAULT, new Date().toISOString());
            db.prepare('INSERT OR IGNORE INTO output_directory_default VALUES(1,?)').run(DEFAULT);
        })();
    }
    function version(id) {
        const row = db.prepare('SELECT v.id,v.root_ref,r.directory FROM output_directory_versions v JOIN storage_roots r ON r.id=v.root_ref WHERE v.id=?').get(id);
        if (!row) throw failure('OUTPUT_DIRECTORY_INVALID');
        return row;
    }
    function current() { return version(db.prepare('SELECT version_id FROM output_directory_default WHERE singleton=1').get().version_id); }
    const publicVersion = row => ({ outputDirectoryVersionId: row.id, outputRootRef: row.root_ref, displayName: path.basename(row.directory) });
    function freeze(snapshot) {
        const root = snapshot.outputDirectoryVersionId ? version(snapshot.outputDirectoryVersionId) : current();
        if (snapshot.outputRootRef && snapshot.outputRootRef !== root.root_ref) throw failure('OUTPUT_DIRECTORY_INVALID');
        return { ...snapshot, outputDirectoryVersionId: root.id, outputRootRef: root.root_ref };
    }
    function select(directory) {
        // Host-only: argument came from the OS directory picker, never renderer/HTTP.
        try {
            const canonical = fs.realpathSync.native(directory), probe = path.join(canonical, '.nova-write-probe-' + randomUUID());
            let fd;
            try { fd = fs.openSync(probe, 'wx'); fs.writeSync(fd, 'probe'); fs.fsyncSync(fd); }
            finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(probe)) fs.unlinkSync(probe); }
            const root = { id: randomUUID(), root_ref: randomUUID(), directory: canonical }, now = new Date().toISOString();
            db.transaction(() => {
                db.prepare('INSERT INTO storage_roots VALUES(?,?,?)').run(root.root_ref, canonical, now);
                db.prepare('INSERT INTO output_directory_versions VALUES(?,?,?)').run(root.id, root.root_ref, now);
                db.prepare('UPDATE output_directory_default SET version_id=? WHERE singleton=1').run(root.id);
            })();
            return publicVersion(root);
        } catch (error) { throw fileFailure(error); }
    }
    function directory(ref = DEFAULT) {
        const root = db.prepare('SELECT directory FROM storage_roots WHERE id=?').get(ref);
        if (!root) throw failure('OUTPUT_DIRECTORY_INVALID');
        // Never recreate an old selected root if the volume/directory disappeared.
        try {
            if (!fs.statSync(root.directory).isDirectory() || fs.realpathSync.native(root.directory) !== root.directory) throw failure('DIRECTORY_NOT_WRITABLE');
            return root.directory;
        } catch (error) { throw fileFailure(error); }
    }
    function checkCurrent() {
        const selected=current();const canonical=directory(selected.root_ref),probe=path.join(canonical,'.nova-write-probe-'+randomUUID());let fd;
        try {fd=fs.openSync(probe,'wx');fs.writeSync(fd,'probe');fs.fsyncSync(fd);return publicVersion(selected);}
        catch(error){throw fileFailure(error);}
        finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(probe))fs.unlinkSync(probe);}
    }
    return { DEFAULT, freeze, version, directory, select, checkCurrent, current: () => publicVersion(current()) };
}
module.exports = { createOutputDirectories };
