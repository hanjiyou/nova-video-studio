const Module = require('node:module'), path = require('node:path'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
// Compile the four changed production modules from HEAD at their original paths.
// No working file or Git metadata is changed; remaining dependencies are unmodified.
for (const relative of ['backend/storage/migrations.js','backend/storage/store.js','backend/storage/workbench-library.js','backend/tasks/service.js']) {
    const filename = path.join(root, relative), source = execFileSync('git', ['-c','safe.directory='+root.replaceAll('\\','/'),'show','HEAD:'+relative], { cwd:root,encoding:'utf8' });
    const module = new Module(filename, moduleParent()); module.filename=filename; module.paths=Module._nodeModulePaths(path.dirname(filename)); require.cache[filename]=module; module._compile(source, filename);
}
function moduleParent() { return module; }
