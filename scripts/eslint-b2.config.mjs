import js from '../backend/node_modules/@eslint/js/src/index.js';
import globals from '../backend/node_modules/globals/index.js';
// Scoped B2 JS/CJS validation, preserving the repository-wide existing lint policy.
export default [js.configs.recommended,{files:['**/*.js','**/*.cjs'],languageOptions:{globals:globals.node,ecmaVersion:'latest',sourceType:'commonjs'},rules:{'no-unused-vars':['error',{argsIgnorePattern:'^_'}]}}];
