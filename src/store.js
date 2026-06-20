const fs = require('fs')
const path = require('path')

const DATA_DIR = path.resolve(__dirname, '..', 'data')
const BACKUPS_DIR = path.join(DATA_DIR, 'backups')

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

function ensureBackupsDir() {
  ensureDir()
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true })
  }
}

function filePath(name) {
  ensureDir()
  return path.join(DATA_DIR, `${name}.json`)
}

function backupFilePath(filename) {
  ensureBackupsDir()
  return path.join(BACKUPS_DIR, filename)
}

function load(name) {
  const fp = filePath(name)
  if (!fs.existsSync(fp)) return null
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'))
  } catch {
    return null
  }
}

function save(name, data) {
  ensureDir()
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), 'utf-8')
}

function loadCommits() {
  return load('commits') || []
}

function saveCommits(commits) {
  save('commits', commits)
}

function loadConfig() {
  return load('config') || {
    ticketPattern: '(\\w+-\\d+)',
    versionPattern: '^v?\\d+\\.\\d+\\.\\d+$',
    versionPrefix: 'v',
    keywords: {
      feature: ['feat', 'feature', 'add', '新增', '支持'],
      fix: ['fix', 'bug', 'patch', '修复', '补丁'],
      breaking: ['break', 'breaking', 'remove', '删除', '移除', '废弃']
    },
    ignorePatterns: ['^Merge', '^Revert', '^WIP', '^chore:', '^ci:']
  }
}

function saveConfig(config) {
  save('config', config)
}

function loadArchives() {
  return load('archives') || []
}

function saveArchives(archives) {
  save('archives', archives)
}

function loadUndoStack() {
  return load('undo') || []
}

function saveUndoStack(stack) {
  save('undo', stack)
}

function listBackups() {
  ensureBackupsDir()
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
    return files
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => {
        const fp = path.join(BACKUPS_DIR, f)
        const stat = fs.statSync(fp)
        return {
          filename: f,
          path: fp,
          created: stat.mtime.toISOString(),
          size: stat.size
        }
      })
  } catch {
    return []
  }
}

function readBackupFile(filename) {
  const fp = backupFilePath(filename)
  if (!fs.existsSync(fp)) return null
  try {
    return {
      content: JSON.parse(fs.readFileSync(fp, 'utf-8')),
      path: fp
    }
  } catch {
    return { content: null, path: fp, parseError: true }
  }
}

function writeBackupFile(filename, data) {
  const fp = backupFilePath(filename)
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8')
  return fp
}

function deleteBackupFile(filename) {
  const fp = backupFilePath(filename)
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp)
    return true
  }
  return false
}

function loadConfigRestoreUndo() {
  return load('config_restore_undo') || null
}

function saveConfigRestoreUndo(snapshot) {
  save('config_restore_undo', snapshot)
}

function clearConfigRestoreUndo() {
  const fp = filePath('config_restore_undo')
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp)
  }
}

function loadRestoreLogs() {
  return load('restore_logs') || []
}

function saveRestoreLogs(logs) {
  save('restore_logs', logs)
}

function appendRestoreLog(entry) {
  const logs = loadRestoreLogs()
  logs.push(entry)
  if (logs.length > 100) {
    logs.splice(0, logs.length - 100)
  }
  saveRestoreLogs(logs)
  return logs
}

function clearRestoreLogs() {
  const fp = filePath('restore_logs')
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp)
  }
}

function loadExportProfiles() {
  const data = load('export_profiles')
  if (!data || !Array.isArray(data.profiles)) {
    return { profiles: [], default: null }
  }
  return data
}

function saveExportProfiles(data) {
  save('export_profiles', data)
}

function loadExportProfileLogs() {
  return load('export_profile_logs') || []
}

function saveExportProfileLogs(logs) {
  save('export_profile_logs', logs)
}

function appendExportProfileLog(entry) {
  const logs = loadExportProfileLogs()
  logs.push(entry)
  if (logs.length > 100) {
    logs.splice(0, logs.length - 100)
  }
  saveExportProfileLogs(logs)
  return logs
}

function loadExportProfileUndo() {
  return load('export_profile_undo') || null
}

function saveExportProfileUndo(snapshot) {
  save('export_profile_undo', snapshot)
}

function clearExportProfileUndo() {
  const fp = filePath('export_profile_undo')
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp)
  }
}

function loadDrafts() {
  return load('drafts') || []
}

function saveDrafts(drafts) {
  save('drafts', drafts)
}

function loadDraftLogs() {
  return load('draft_logs') || []
}

function saveDraftLogs(logs) {
  save('draft_logs', logs)
}

function appendDraftLog(entry) {
  const logs = loadDraftLogs()
  logs.push(entry)
  if (logs.length > 100) {
    logs.splice(0, logs.length - 100)
  }
  saveDraftLogs(logs)
  return logs
}

function loadDraftUndo() {
  return load('draft_undo') || null
}

function saveDraftUndo(snapshot) {
  save('draft_undo', snapshot)
}

function clearDraftUndo() {
  const fp = filePath('draft_undo')
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp)
  }
}

function loadDraftUndoStack() {
  return load('draft_undo_stack') || []
}

function saveDraftUndoStack(stack) {
  save('draft_undo_stack', stack)
}

function clearDraftUndoStack() {
  const fp = filePath('draft_undo_stack')
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp)
  }
}

function loadVersionRegistry() {
  return load('version_registry') || { entries: [] }
}

function saveVersionRegistry(data) {
  save('version_registry', data)
}

function loadVersionRegistryLogs() {
  return load('version_registry_logs') || []
}

function saveVersionRegistryLogs(logs) {
  save('version_registry_logs', logs)
}

function appendVersionRegistryLog(entry) {
  const logs = loadVersionRegistryLogs()
  logs.push(entry)
  if (logs.length > 200) {
    logs.splice(0, logs.length - 200)
  }
  saveVersionRegistryLogs(logs)
  return logs
}

function clearVersionRegistryLogs() {
  const fp = filePath('version_registry_logs')
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp)
  }
}

function loadVersionRegistryUndo() {
  return load('version_registry_undo') || null
}

function saveVersionRegistryUndo(snapshot) {
  save('version_registry_undo', snapshot)
}

function clearVersionRegistryUndo() {
  const fp = filePath('version_registry_undo')
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp)
  }
}

module.exports = {
  loadCommits,
  saveCommits,
  loadConfig,
  saveConfig,
  loadArchives,
  saveArchives,
  loadUndoStack,
  saveUndoStack,
  listBackups,
  readBackupFile,
  writeBackupFile,
  deleteBackupFile,
  loadConfigRestoreUndo,
  saveConfigRestoreUndo,
  clearConfigRestoreUndo,
  loadRestoreLogs,
  saveRestoreLogs,
  appendRestoreLog,
  clearRestoreLogs,
  loadExportProfiles,
  saveExportProfiles,
  loadExportProfileLogs,
  saveExportProfileLogs,
  appendExportProfileLog,
  loadExportProfileUndo,
  saveExportProfileUndo,
  clearExportProfileUndo,
  loadDrafts,
  saveDrafts,
  loadDraftLogs,
  saveDraftLogs,
  appendDraftLog,
  loadDraftUndo,
  saveDraftUndo,
  clearDraftUndo,
  loadDraftUndoStack,
  saveDraftUndoStack,
  clearDraftUndoStack,
  loadVersionRegistry,
  saveVersionRegistry,
  loadVersionRegistryLogs,
  saveVersionRegistryLogs,
  appendVersionRegistryLog,
  clearVersionRegistryLogs,
  loadVersionRegistryUndo,
  saveVersionRegistryUndo,
  clearVersionRegistryUndo,
  DATA_DIR,
  BACKUPS_DIR
}
