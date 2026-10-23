'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, mode TEXT NOT NULL, request_json TEXT NOT NULL,
  result_json TEXT, error TEXT, warning TEXT, created_at TEXT NOT NULL, completed_at TEXT, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS task_items (
  task_id TEXT NOT NULL, item_index INTEGER NOT NULL, status TEXT NOT NULL, image_data TEXT,
  error TEXT, created_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY(task_id,item_index)
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_expires_at ON tasks(expires_at);
CREATE INDEX IF NOT EXISTS idx_task_items_task_id ON task_items(task_id);
CREATE TABLE IF NOT EXISTS plugin_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
  kind TEXT NOT NULL, bytes INTEGER NOT NULL, task_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_media_hash_task ON plugin_media(hash,task_id);
CREATE INDEX IF NOT EXISTS idx_plugin_media_task ON plugin_media(task_id);
`;
const DURABLE_SCHEMA = `
CREATE TABLE connections (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, current_version_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(current_version_id) REFERENCES connection_versions(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE connection_versions (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id),
  base_url TEXT NOT NULL, provider TEXT NOT NULL, credential_ref TEXT, created_at TEXT NOT NULL
);
CREATE TRIGGER connection_versions_immutable_update BEFORE UPDATE ON connection_versions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CONNECTION_VERSION'); END;
CREATE TRIGGER connection_versions_immutable_delete BEFORE DELETE ON connection_versions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CONNECTION_VERSION'); END;
ALTER TABLE tasks ADD COLUMN local_request_id TEXT COLLATE NOCASE;
ALTER TABLE tasks ADD COLUMN connection_version_id TEXT REFERENCES connection_versions(id);
ALTER TABLE tasks ADD COLUMN capability_version_id TEXT;
ALTER TABLE tasks ADD COLUMN adapter_id TEXT;
ALTER TABLE tasks ADD COLUMN adapter_version TEXT;
ALTER TABLE tasks ADD COLUMN upstream_task_id TEXT;
ALTER TABLE tasks ADD COLUMN input_snapshot_json TEXT;
ALTER TABLE tasks ADD COLUMN output_directory_version_id TEXT;
ALTER TABLE tasks ADD COLUMN output_root_ref TEXT;
CREATE UNIQUE INDEX idx_tasks_local_request_id ON tasks(local_request_id) WHERE local_request_id IS NOT NULL;
CREATE TRIGGER task_snapshot_immutable BEFORE UPDATE OF input_snapshot_json,local_request_id,connection_version_id,capability_version_id,adapter_id,adapter_version,output_directory_version_id,output_root_ref ON tasks
WHEN OLD.input_snapshot_json IS NOT NULL AND (
  NEW.input_snapshot_json IS NOT OLD.input_snapshot_json OR NEW.local_request_id IS NOT OLD.local_request_id
  OR NEW.connection_version_id IS NOT OLD.connection_version_id OR NEW.capability_version_id IS NOT OLD.capability_version_id
  OR NEW.adapter_id IS NOT OLD.adapter_id OR NEW.adapter_version IS NOT OLD.adapter_version
  OR NEW.output_directory_version_id IS NOT OLD.output_directory_version_id OR NEW.output_root_ref IS NOT OLD.output_root_ref)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TASK_SNAPSHOT'); END;
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX idx_task_events_task ON task_events(task_id,id);
CREATE TRIGGER task_created_event AFTER INSERT ON tasks BEGIN
  INSERT INTO task_events(task_id,type,payload_json,created_at) VALUES(NEW.id,'legacy_task_created',json_object('status',NEW.status),NEW.created_at);
END;
CREATE TRIGGER task_status_event AFTER UPDATE OF status ON tasks WHEN NEW.status IS NOT OLD.status BEGIN
  INSERT INTO task_events(task_id,type,payload_json,created_at) VALUES(NEW.id,'legacy_status_observed',json_object('previous',OLD.status,'next',NEW.status),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TABLE assets (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('image','video','audio')),
  storage_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length>0), sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  width INTEGER, height INTEGER, duration_seconds REAL, source_kind TEXT NOT NULL,
  validation_state TEXT NOT NULL DEFAULT 'unverified',
  availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','missing','corrupt')),
  created_at TEXT NOT NULL, UNIQUE(sha256,mime_type,kind)
);
CREATE TABLE task_assets (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id), role TEXT NOT NULL CHECK(role IN ('input','output')),
  position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(task_id,role,position)
);
CREATE INDEX idx_task_assets_asset ON task_assets(asset_id);
CREATE TABLE asset_legacy_links (
  kind TEXT NOT NULL CHECK(kind IN ('image','plugin-media')), relative_key TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id), PRIMARY KEY(kind,relative_key)
);
CREATE TABLE drafts (
  mode TEXT PRIMARY KEY, prompt TEXT NOT NULL, model TEXT NOT NULL, parameters_json TEXT NOT NULL,
  revision INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE draft_assets (
  mode TEXT NOT NULL REFERENCES drafts(mode) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id), position INTEGER NOT NULL CHECK(position>=0),
  PRIMARY KEY(mode,position)
);
CREATE INDEX idx_draft_assets_asset ON draft_assets(asset_id);
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO task_events(task_id,type,payload_json,created_at)
SELECT id,'legacy_record_retained',json_object('status',status),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks;
`;
const CONNECTION_SCHEMA = `
CREATE TABLE credential_entries (
  id TEXT PRIMARY KEY, ciphertext BLOB, created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE connection_preferences (
  connection_version_id TEXT PRIMARY KEY REFERENCES connection_versions(id),
  protocol TEXT NOT NULL CHECK(protocol='openai'), default_image_model TEXT NOT NULL, default_video_model TEXT NOT NULL
);
CREATE TRIGGER connection_preferences_immutable_update BEFORE UPDATE ON connection_preferences
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CONNECTION_PREFERENCES'); END;
CREATE TRIGGER connection_preferences_immutable_delete BEFORE DELETE ON connection_preferences
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CONNECTION_PREFERENCES'); END;
CREATE TABLE connection_defaults (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), connection_id TEXT NOT NULL REFERENCES connections(id)
);
CREATE TABLE connection_checks (
  connection_version_id TEXT PRIMARY KEY REFERENCES connection_versions(id), validation_state TEXT NOT NULL,
  last_checked_at TEXT, last_success_at TEXT, models_fetched_at TEXT, models_json TEXT NOT NULL DEFAULT '[]', error_code TEXT
);
CREATE TABLE model_capabilities (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL,
  protocol TEXT NOT NULL, parameters_json TEXT NOT NULL, evidence_level TEXT NOT NULL,
  evidence_version TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(provider,base_url,model,mode,protocol,parameters_json,evidence_version)
);
CREATE TRIGGER model_capabilities_immutable_update BEFORE UPDATE ON model_capabilities
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPABILITY_VERSION'); END;
CREATE TRIGGER model_capabilities_immutable_delete BEFORE DELETE ON model_capabilities
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPABILITY_VERSION'); END;
`;
const TASK_SCHEMA = `
ALTER TABLE tasks ADD COLUMN dispatch_started_at TEXT;
ALTER TABLE tasks ADD COLUMN remote_state TEXT;
ALTER TABLE tasks ADD COLUMN raw_status TEXT;
ALTER TABLE tasks ADD COLUMN remote_progress REAL;
ALTER TABLE tasks ADD COLUMN pause_reason TEXT;
ALTER TABLE tasks ADD COLUMN not_before_at TEXT;
ALTER TABLE tasks ADD COLUMN next_poll_at TEXT;
ALTER TABLE tasks ADD COLUMN poll_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN poll_budget_started_at TEXT;
ALTER TABLE tasks ADD COLUMN task_error_json TEXT;
ALTER TABLE tasks ADD COLUMN result_sources_json TEXT;
ALTER TABLE tasks ADD COLUMN requires_continue INTEGER NOT NULL DEFAULT 0;
CREATE TABLE task_downloads (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('waiting','running','failed','completed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_task_dispatch ON tasks(status,requires_continue,created_at);
CREATE TRIGGER task_upstream_id_immutable BEFORE UPDATE OF upstream_task_id ON tasks
WHEN OLD.upstream_task_id IS NOT NULL AND NEW.upstream_task_id IS NOT OLD.upstream_task_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_UPSTREAM_TASK_ID'); END;
CREATE TRIGGER task_dispatch_immutable BEFORE UPDATE OF dispatch_started_at ON tasks
WHEN OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_started_at IS NOT OLD.dispatch_started_at
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DISPATCH_BOUNDARY'); END;
`;
const MIGRATIONS = [
    { version: 1, name: 'legacy-baseline', sql: BASE_SCHEMA },
    { version: 2, name: 'durable-workbench-storage', sql: DURABLE_SCHEMA },
    { version: 3, name: 'protected-connections-and-capabilities', sql: CONNECTION_SCHEMA },
    { version: 4, name: 'durable-task-orchestration', sql: TASK_SCHEMA },
];
const checksum = text => createHash('sha256').update(text).digest('hex');
async function migrateDatabase({ db, dbPath, backupDirectory, migrations = MIGRATIONS }) {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    const hasHistory = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (!hasHistory) {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (tables.length) {
            const columns = db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name);
            if (!['id', 'status', 'mode', 'request_json', 'created_at', 'expires_at'].every(name => columns.includes(name)))
                throw Object.assign(new Error('目标数据库不是可识别的本应用存储，未修改原文件。'), { code: 'MIGRATION_SOURCE_UNRECOGNIZED' });
        }
    }
    const applied = hasHistory ? db.prepare('SELECT * FROM schema_migrations ORDER BY version').all() : [];
    for (let index = 0; index < applied.length; index++) {
        const migration = migrations[index];
        if (!migration || applied[index].version !== migration.version || applied[index].checksum !== checksum(migration.sql)) {
            throw Object.assign(new Error('存储迁移历史不匹配，原库保持不变。'), { code: 'MIGRATION_HISTORY_MISMATCH' });
        }
    }
    const pending = migrations.slice(applied.length);
    if (!pending.length)
        return { applied: [], backupFile: null };
    const directory = path.resolve(backupDirectory || path.join(path.dirname(dbPath), 'backups'));
    const backupFile = path.join(directory, 'schema-' + Date.now() + '-' + randomUUID() + '.sqlite');
    try {
        fs.mkdirSync(directory, { recursive: true });
        await db.backup(backupFile); // SQLite online backup includes committed WAL pages consistently.
        const backup = new Database(backupFile, { readonly: true, fileMustExist: true });
        try {
            if (backup.pragma('quick_check', { simple: true }) !== 'ok')
                throw new Error('Invalid migration backup');
        }
        finally {
            backup.close();
        }
        const manifest = { createdAt: new Date().toISOString(), fromVersion: applied.at(-1)?.version || 0,
            toVersion: pending.at(-1).version, sha256: checksum(fs.readFileSync(backupFile)) };
        fs.writeFileSync(backupFile + '.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    }
    catch (cause) {
        throw Object.assign(new Error('无法完成一致备份，未执行存储升级。', { cause }), { code: 'STORAGE_BACKUP_FAILED' });
    }
    try {
        db.transaction(() => {
            db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL,backup_file TEXT NOT NULL
      )`);
            for (const migration of pending) {
                db.exec(migration.sql);
                db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?,?)').run(migration.version, migration.name, checksum(migration.sql), new Date().toISOString(), path.basename(backupFile));
            }
        }).immediate();
    }
    catch (cause) {
        throw Object.assign(new Error('存储升级失败，数据库事务已回滚，升级前备份已保留。', { cause }), { code: 'STORAGE_MIGRATION_FAILED', backupFile });
    }
    db.pragma('journal_mode = WAL');
    return { applied: pending.map(row => row.version), backupFile };
}
module.exports = { migrateDatabase, MIGRATIONS, BASE_SCHEMA };
