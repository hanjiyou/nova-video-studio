'use strict';
// Query predicates are shared by pagination and group counts. Physical availability
// is projected by the asset reader; a missing saved file keeps its durable record.
function createWorkbenchQueries({ db, record, group, fail }) {
    const retry = "EXISTS(SELECT 1 FROM task_download_attempts d WHERE d.task_id=tasks.id AND d.outcome IS NULL)";
    const saved = "tasks.saved_at IS NOT NULL AND EXISTS(SELECT 1 FROM task_assets a WHERE a.task_id=tasks.id AND a.role='output')";
    const active = `(${retry} OR (tasks.local_outcome IS NULL AND tasks.requires_continue=0 AND tasks.status IN ('local_queued','submitting','remote_queued','generating','remote_completed','downloading')))`;
    const category = `CASE WHEN ${active} THEN 'active' WHEN (${saved}) THEN 'completed' ELSE 'unfinished' END`;
    const visible = scope => scope === 'library' ? `NOT EXISTS(SELECT 1 FROM workbench_hidden_tasks h WHERE h.task_id=tasks.id) AND (${saved})` : 'NOT EXISTS(SELECT 1 FROM workbench_removed_tasks r WHERE r.task_id=tasks.id)';
    function listTasks({ limit=50, offset=0, kind='', search='', model='', status='', scope='workbench', groupId='', category: selected='' } = {}) {
        if (selected==='all') selected='';
        if (!Number.isInteger(limit) || limit<1 || limit>100 || !Number.isInteger(offset) || offset<0) throw fail('INVALID_PAGINATION');
        if (!['','image','video'].includes(kind) || [search,model,status].some(value=>typeof value!=='string'||value.length>512) || !['workbench','library'].includes(scope) || !['','active','unfinished','completed'].includes(selected) || typeof groupId!=='string') throw fail('INVALID_HISTORY_FILTER');
        const base=[visible(scope)], args=[];
        if (groupId) { const checked=group(groupId); base.push('EXISTS(SELECT 1 FROM task_group_memberships m WHERE m.task_id=tasks.id AND m.group_id=?)'); args.push(checked.id); }
        const baseClause=' WHERE '+base.join(' AND '), baseArgs=[...args], where=[...base];
        const value = field => `COALESCE(json_extract(CASE WHEN json_valid(input_snapshot_json) THEN input_snapshot_json ELSE '{}' END,'$.${field}'),json_extract(CASE WHEN json_valid(request_json) THEN request_json ELSE '{}' END,'$.${field}'),'')`;
        if (kind) where.push(kind==='image' ? "(mode LIKE 'image.%' OR mode IN ('text-to-image','image-to-image'))" : "(mode LIKE 'video.%' OR mode IN ('plugin','legacy.plugin'))");
        if (search) { where.push(`(instr(lower(${value('prompt')}),lower(?))>0 OR instr(lower(${value('model')}),lower(?))>0)`); args.push(search,search); }
        if (model) { where.push(value('model')+'=?'); args.push(model); }
        if (status) { where.push('status=?'); args.push(status); }
        if (selected) { where.push('('+category+')=?'); args.push(selected); }
        const clause=' WHERE '+where.join(' AND ');
        return { items:db.prepare('SELECT tasks.*,'+category+' AS display_category FROM tasks'+clause+' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(...args,limit,offset).map(record), total:db.prepare('SELECT count(*) n FROM tasks'+clause).get(...args).n, unfilteredTotal:db.prepare('SELECT count(*) n FROM tasks'+baseClause).get(...baseArgs).n };
    }
    function counts(groupId) {
        const member='EXISTS(SELECT 1 FROM task_group_memberships m WHERE m.task_id=tasks.id AND m.group_id=?)';
        return { workCount:db.prepare('SELECT count(*) n FROM tasks WHERE '+visible('library')+' AND '+member).get(groupId).n, taskCount:db.prepare('SELECT count(*) n FROM tasks WHERE '+visible('workbench')+' AND '+member).get(groupId).n };
    }
    return { listTasks, counts, categoryFor:id=>db.prepare('SELECT '+category+' AS value FROM tasks WHERE id=?').get(id)?.value || 'unfinished' };
}
module.exports = { createWorkbenchQueries };
