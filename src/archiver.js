const store = require('./store')
const config = require('./config')
const validator = require('./validator')
const undo = require('./undo')

function archive(version) {
  const check = validator.checkArchiveReadiness(version)
  if (!check.ready) {
    throw new Error(check.reason)
  }

  undo.push('archive', `归档版本 ${version}`)

  const commits = store.loadCommits()
  const cfg = config.get()
  const versionCommits = commits.filter(c => c.category !== 'ignored').map(c => JSON.parse(JSON.stringify(c)))

  const snapshot = {
    version,
    date: new Date().toISOString(),
    commits: versionCommits,
    rules: JSON.parse(JSON.stringify(cfg)),
    commitCount: versionCommits.length
  }

  const archives = store.loadArchives()
  const existing = archives.findIndex(a => a.version === version)
  if (existing >= 0) {
    archives[existing] = snapshot
  } else {
    archives.push(snapshot)
  }
  store.saveArchives(archives)

  const remaining = commits.filter(c => c.category === 'ignored')
  store.saveCommits(remaining)

  return snapshot
}

function listArchives() {
  const archives = store.loadArchives()
  return archives.map(a => ({
    version: a.version,
    date: a.date,
    commitCount: a.commitCount
  }))
}

function getArchive(version) {
  const archives = store.loadArchives()
  return archives.find(a => a.version === version) || null
}

function deleteArchive(version) {
  const archives = store.loadArchives()
  const idx = archives.findIndex(a => a.version === version)
  if (idx < 0) throw new Error(`归档不存在: ${version}`)
  archives.splice(idx, 1)
  store.saveArchives(archives)
}

module.exports = { archive, listArchives, getArchive, deleteArchive }
