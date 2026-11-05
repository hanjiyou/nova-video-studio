'use strict';
// Shared by the settings UI, persistent store and desktop editor host.
const DEFAULT_EDITOR_SETTINGS = Object.freeze({ startupTimeoutSeconds: 90 });
const MIN_STARTUP_SECONDS = 30, MAX_STARTUP_SECONDS = 300;
const EDITOR_READINESS_TIMEOUT_MS = 30000;
function validEditorSettings(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 1 && Object.hasOwn(value,'startupTimeoutSeconds') &&
    Number.isInteger(value.startupTimeoutSeconds) && value.startupTimeoutSeconds >= MIN_STARTUP_SECONDS && value.startupTimeoutSeconds <= MAX_STARTUP_SECONDS);
}
function normalizeEditorSettings(value) {
  return { startupTimeoutSeconds: validEditorSettings(value) ? value.startupTimeoutSeconds : DEFAULT_EDITOR_SETTINGS.startupTimeoutSeconds };
}
module.exports = { DEFAULT_EDITOR_SETTINGS, MIN_STARTUP_SECONDS, MAX_STARTUP_SECONDS, EDITOR_READINESS_TIMEOUT_MS, validEditorSettings, normalizeEditorSettings };
