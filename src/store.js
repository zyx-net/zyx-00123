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
  DATA_DIR,
  BACKUPS_DIR
}
