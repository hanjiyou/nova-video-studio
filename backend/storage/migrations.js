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
    { version: 5, name: 'verified-media-and-output-roots', sql: `
CREATE TABLE storage_roots (id TEXT PRIMARY KEY, directory TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE output_directory_versions (id TEXT PRIMARY KEY, root_ref TEXT NOT NULL REFERENCES storage_roots(id), created_at TEXT NOT NULL);
CREATE TABLE output_directory_default (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version_id TEXT NOT NULL REFERENCES output_directory_versions(id));
CREATE TRIGGER output_version_immutable_update BEFORE UPDATE ON output_directory_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OUTPUT_VERSION'); END;
CREATE TRIGGER output_version_immutable_delete BEFORE DELETE ON output_directory_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OUTPUT_VERSION'); END;
CREATE TRIGGER storage_root_immutable_update BEFORE UPDATE ON storage_roots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_STORAGE_ROOT'); END;
CREATE TRIGGER storage_root_immutable_delete BEFORE DELETE ON storage_roots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_STORAGE_ROOT'); END;
CREATE TABLE assets_next (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('image','video','audio')),
 storage_key TEXT NOT NULL, display_name TEXT NOT NULL, mime_type TEXT NOT NULL,
 byte_length INTEGER NOT NULL CHECK(byte_length>0), sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 width INTEGER, height INTEGER, duration_seconds REAL, source_kind TEXT NOT NULL,
 validation_state TEXT NOT NULL DEFAULT 'unverified',
 availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','missing','corrupt')),
 created_at TEXT NOT NULL, root_ref TEXT REFERENCES storage_roots(id),
 UNIQUE(root_ref,storage_key), UNIQUE(root_ref,sha256,mime_type,kind)
);
INSERT INTO assets_next SELECT *,NULL FROM assets;
CREATE TABLE task_assets_copy AS SELECT * FROM task_assets;
CREATE TABLE draft_assets_copy AS SELECT * FROM draft_assets;
CREATE TABLE asset_legacy_links_copy AS SELECT * FROM asset_legacy_links;
DROP TABLE task_assets;
DROP TABLE draft_assets;
DROP TABLE asset_legacy_links;
DROP TABLE assets;
ALTER TABLE assets_next RENAME TO assets;
CREATE UNIQUE INDEX idx_assets_default_identity ON assets(sha256,mime_type,kind) WHERE root_ref IS NULL;
CREATE UNIQUE INDEX idx_assets_default_key ON assets(storage_key) WHERE root_ref IS NULL;
CREATE TABLE task_assets (
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, asset_id TEXT NOT NULL REFERENCES assets(id),
 role TEXT NOT NULL CHECK(role IN ('input','output')), position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(task_id,role,position)
);
CREATE INDEX idx_task_assets_asset ON task_assets(asset_id);
CREATE TABLE draft_assets (
 mode TEXT NOT NULL REFERENCES drafts(mode) ON DELETE CASCADE, asset_id TEXT NOT NULL REFERENCES assets(id),
 position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(mode,position)
);
CREATE INDEX idx_draft_assets_asset ON draft_assets(asset_id);
CREATE TABLE asset_legacy_links (
 kind TEXT NOT NULL CHECK(kind IN ('image','plugin-media')),relative_key TEXT NOT NULL,
 asset_id TEXT NOT NULL REFERENCES assets(id),PRIMARY KEY(kind,relative_key)
);
INSERT INTO task_assets SELECT * FROM task_assets_copy;
INSERT INTO draft_assets SELECT * FROM draft_assets_copy;
INSERT INTO asset_legacy_links SELECT * FROM asset_legacy_links_copy;
DROP TABLE task_assets_copy;
DROP TABLE draft_assets_copy;
DROP TABLE asset_legacy_links_copy;
ALTER TABLE task_downloads ADD COLUMN refresh_not_before_at TEXT;
ALTER TABLE task_downloads ADD COLUMN refresh_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_downloads ADD COLUMN refresh_budget_started_at TEXT;
` },
    { version: 6, name: 'workbench-library-and-submission-intents', sql: `
CREATE TABLE workbench_hidden_tasks (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, hidden_at TEXT NOT NULL
);
CREATE TABLE workbench_submission_intents (
 local_request_id TEXT PRIMARY KEY COLLATE NOCASE, input_json TEXT NOT NULL, created_at TEXT NOT NULL, attempt_started_at TEXT
);
` },
    { version: 7, name: 'task-lifecycle-contract', sql: `

ALTER TABLE tasks ADD COLUMN execution_media_kind TEXT CHECK(execution_media_kind IS NULL OR execution_media_kind IN ('image','video'));
ALTER TABLE tasks ADD COLUMN execution_timeout_seconds INTEGER CHECK(execution_timeout_seconds IS NULL OR (typeof(execution_timeout_seconds)='integer' AND execution_timeout_seconds BETWEEN 30 AND 1800));
ALTER TABLE tasks ADD COLUMN execution_attempt_id TEXT;
ALTER TABLE tasks ADD COLUMN execution_deadline_at TEXT;
ALTER TABLE tasks ADD COLUMN local_outcome TEXT CHECK(local_outcome IS NULL OR local_outcome IN ('completed','failed','timed_out','cancelled'));
ALTER TABLE tasks ADD COLUMN local_finished_at TEXT;
ALTER TABLE tasks ADD COLUMN remote_outcome TEXT CHECK(remote_outcome IS NULL OR remote_outcome IN ('not_dispatched','unknown','confirmed_result','confirmed_rejected','confirmed_failed','confirmed_cancelled'));
ALTER TABLE tasks ADD COLUMN execution_phase TEXT CHECK(execution_phase IS NULL OR execution_phase IN ('reference_upload','submitting','receiving','parsing','remote_waiting','downloading','validating','saving'));
ALTER TABLE tasks ADD COLUMN execution_phase_started_at TEXT;
CREATE TRIGGER task_execution_snapshot_immutable BEFORE UPDATE OF execution_media_kind,execution_timeout_seconds ON tasks
WHEN NEW.execution_media_kind IS NOT OLD.execution_media_kind OR NEW.execution_timeout_seconds IS NOT OLD.execution_timeout_seconds
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXECUTION_SNAPSHOT'); END;
CREATE TRIGGER task_execution_boundary_immutable BEFORE UPDATE OF execution_attempt_id,execution_deadline_at ON tasks
WHEN (OLD.execution_attempt_id IS NOT NULL AND NEW.execution_attempt_id IS NOT OLD.execution_attempt_id)
 OR (OLD.execution_deadline_at IS NOT NULL AND NEW.execution_deadline_at IS NOT OLD.execution_deadline_at)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXECUTION_BOUNDARY'); END;
CREATE UNIQUE INDEX idx_task_execution_attempt ON tasks(execution_attempt_id) WHERE execution_attempt_id IS NOT NULL;
-- I05 will use this task-display scope. Existing library-wide hiding is untouched.
CREATE TABLE workbench_removed_tasks (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, removed_at TEXT NOT NULL
);
` },
    { version: 8, name: 'task-execution-runtime', sql: `
CREATE TABLE task_download_attempts (
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 started_at TEXT NOT NULL,deadline_at TEXT NOT NULL,timeout_seconds INTEGER NOT NULL CHECK(timeout_seconds BETWEEN 30 AND 1800),
 outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed','failed','timed_out','cancelled')),finished_at TEXT
);
CREATE UNIQUE INDEX idx_task_active_download_attempt ON task_download_attempts(task_id) WHERE outcome IS NULL;
CREATE TRIGGER task_local_outcome_immutable BEFORE UPDATE OF local_outcome,local_finished_at ON tasks
WHEN (OLD.local_outcome IS NOT NULL AND NEW.local_outcome IS NOT OLD.local_outcome)
 OR (OLD.local_finished_at IS NOT NULL AND NEW.local_finished_at IS NOT OLD.local_finished_at)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LOCAL_OUTCOME'); END;
` },
    { version: 9, name: 'independent-download-budgets', sql: `
ALTER TABLE tasks ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 1 CHECK(lifecycle_version IN (1,2));
ALTER TABLE tasks ADD COLUMN generation_outcome TEXT CHECK(generation_outcome IS NULL OR generation_outcome IN ('completed','failed','timed_out','cancelled'));
ALTER TABLE tasks ADD COLUMN generation_finished_at TEXT;
CREATE TRIGGER task_lifecycle_version_immutable BEFORE UPDATE OF lifecycle_version ON tasks
WHEN NEW.lifecycle_version IS NOT OLD.lifecycle_version BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LIFECYCLE_VERSION'); END;
CREATE TRIGGER task_generation_outcome_immutable BEFORE UPDATE OF generation_outcome,generation_finished_at ON tasks
WHEN (OLD.generation_outcome IS NOT NULL AND NEW.generation_outcome IS NOT OLD.generation_outcome)
 OR (OLD.generation_finished_at IS NOT NULL AND NEW.generation_finished_at IS NOT OLD.generation_finished_at)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_GENERATION_OUTCOME'); END;
DROP INDEX idx_task_active_download_attempt;
ALTER TABLE task_download_attempts RENAME TO task_download_attempts_v8;
CREATE TABLE task_download_attempts (
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 started_at TEXT,deadline_at TEXT,timeout_seconds INTEGER NOT NULL CHECK(timeout_seconds BETWEEN 30 AND 1800),
 outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed','failed','timed_out','cancelled')),finished_at TEXT,
 queued_at TEXT,progress_json TEXT,
 CHECK((started_at IS NULL)=(deadline_at IS NULL))
);
INSERT INTO task_download_attempts(rowid,id,task_id,started_at,deadline_at,timeout_seconds,outcome,finished_at)
 SELECT rowid,id,task_id,started_at,deadline_at,timeout_seconds,outcome,finished_at FROM task_download_attempts_v8 ORDER BY rowid;
DROP TABLE task_download_attempts_v8;
CREATE UNIQUE INDEX idx_task_active_download_attempt ON task_download_attempts(task_id) WHERE outcome IS NULL;
CREATE TRIGGER download_budget_immutable BEFORE UPDATE OF started_at,deadline_at,timeout_seconds ON task_download_attempts
WHEN NEW.timeout_seconds IS NOT OLD.timeout_seconds OR (OLD.started_at IS NOT NULL AND (NEW.started_at IS NOT OLD.started_at OR NEW.deadline_at IS NOT OLD.deadline_at))
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DOWNLOAD_BUDGET'); END;
` },
    { version: 10, name: 'download-recovery-checkpoints', sql: `
ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_download_attempts ADD COLUMN error_code TEXT;
ALTER TABLE task_download_attempts ADD COLUMN http_status INTEGER;
CREATE TRIGGER asset_availability_revision AFTER UPDATE OF availability ON assets WHEN NEW.availability IS NOT OLD.availability BEGIN UPDATE tasks SET revision=revision+1 WHERE id IN (SELECT task_id FROM task_assets WHERE asset_id=NEW.id); END;
CREATE TRIGGER task_revision AFTER UPDATE ON tasks WHEN NEW.revision=OLD.revision
BEGIN UPDATE tasks SET revision=OLD.revision+1 WHERE id=NEW.id; END;
CREATE TRIGGER task_removed_revision AFTER INSERT ON workbench_removed_tasks BEGIN UPDATE tasks SET revision=revision+1 WHERE id=NEW.task_id; END;
CREATE TABLE task_download_actions(request_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,attempt_id TEXT NOT NULL REFERENCES task_download_attempts(id),created_at TEXT NOT NULL);
CREATE TABLE task_download_files(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,source_key TEXT NOT NULL,asset_id TEXT NOT NULL REFERENCES assets(id),sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(task_id,source_key));
` },
    { version: 11, name: 'opensosen-transport-routes', sql: `
CREATE TABLE connection_routes (
 connection_id TEXT PRIMARY KEY REFERENCES connections(id),route TEXT NOT NULL CHECK(route IN ('cn','com')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1)
);
INSERT INTO connection_routes(connection_id,route,revision)
 SELECT c.id,'cn',1 FROM connections c JOIN connection_versions v ON v.id=c.current_version_id
 WHERE v.provider='opensosen' AND v.base_url IN ('https://newapi.opensosen.com/v1','https://newapi.opensosen.cn/v1');
DELETE FROM connection_checks WHERE connection_version_id IN (SELECT v.id FROM connection_versions v JOIN connection_routes r ON r.connection_id=v.connection_id);
ALTER TABLE tasks ADD COLUMN transport_route_json TEXT;
ALTER TABLE task_download_attempts ADD COLUMN transport_route_json TEXT;
ALTER TABLE task_downloads ADD COLUMN transport_route_json TEXT;
CREATE TRIGGER task_transport_route_immutable BEFORE UPDATE OF transport_route_json ON tasks
WHEN OLD.transport_route_json IS NOT NULL AND NEW.transport_route_json IS NOT OLD.transport_route_json
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TRANSPORT_ROUTE'); END;
CREATE TRIGGER download_transport_route_immutable BEFORE UPDATE OF transport_route_json ON task_download_attempts
WHEN OLD.transport_route_json IS NOT NULL AND NEW.transport_route_json IS NOT OLD.transport_route_json
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DOWNLOAD_ROUTE'); END;
` },
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
