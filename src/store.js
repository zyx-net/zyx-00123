const fs = require('fs')
const path = require('path')

const DATA_DIR = path.resolve(__dirname, '..', 'data')

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

function filePath(name) {
  ensureDir()
  return path.join(DATA_DIR, `${name}.json`)
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

module.exports = {
  loadCommits,
  saveCommits,
  loadConfig,
  saveConfig,
  loadArchives,
  saveArchives,
  loadUndoStack,
  saveUndoStack,
  DATA_DIR
}
