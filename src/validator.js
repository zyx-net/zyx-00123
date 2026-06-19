const store = require('./store')
const config = require('./config')
const undo = require('./undo')

function validate() {
  const commits = store.loadCommits()
  const cfg = config.get()
  const versionRe = new RegExp(cfg.versionPattern)
  const errors = []
  const warnings = []

  const seen = new Map()
  commits.forEach(c => {
    if (c.category === 'ignored') return

    if (c.id && seen.has(c.id)) {
      const err = { type: 'duplicate', commitId: c.id, message: `重复提交: ${c.id} (hash=${c.hash}, message="${c.message}")` }
      errors.push(err)
    } else {
      seen.set(c.id, true)
    }

    if (!c.ticket) {
      const warn = { type: 'missing_ticket', commitId: c.id, message: `缺失工单号: ${c.id} (message="${c.message}")` }
      warnings.push(warn)
      if (!c.issues.includes('缺失工单号')) {
        c.issues.push('缺失工单号')
      }
    }

    if (c.version && !versionRe.test(c.version)) {
      const warn = { type: 'bad_version', commitId: c.id, message: `版本号不合规: ${c.version} (commit=${c.id})` }
      warnings.push(warn)
      if (!c.issues.some(i => i.startsWith('版本号不合规'))) {
        c.issues.push(`版本号不合规: ${c.version} (应匹配 ${cfg.versionPattern})`)
      }
    }
  })

  store.saveCommits(commits)
  return { errors, warnings }
}

function checkArchiveReadiness(version) {
  const commits = store.loadCommits()
  const cfg = config.get()
  const versionRe = new RegExp(cfg.versionPattern)

  if (!version) {
    return { ready: false, reason: '未指定版本号' }
  }
  if (!versionRe.test(version)) {
    return { ready: false, reason: `版本号不合规: ${version} (应匹配 ${cfg.versionPattern})` }
  }

  const versionCommits = commits.filter(c => c.category !== 'ignored')
  if (versionCommits.length === 0) {
    return { ready: false, reason: '没有可归档的提交' }
  }

  const unresolved = versionCommits.filter(c => c.issues && c.issues.length > 0 && !c.resolved)
  if (unresolved.length > 0) {
    const details = unresolved.map(c =>
      `  - ${c.id}: ${c.issues.join(', ')} (message="${c.message}")`
    ).join('\n')
    return {
      ready: false,
      reason: `存在未解决的校验项，不能进入正式发布稿:\n${details}`
    }
  }

  const unreviewed = versionCommits.filter(c => !c.reviewed)
  if (unreviewed.length > 0) {
    const details = unreviewed.map(c =>
      `  - ${c.id} (message="${c.message}")`
    ).join('\n')
    return {
      ready: false,
      reason: `存在未复核的提交:\n${details}`
    }
  }

  return { ready: true }
}

function resolveIssue(commitId, issueIndex) {
  undo.push('resolve', `解决 ${commitId.substring(0, 8)} 的问题#${issueIndex}`)
  const commits = store.loadCommits()
  const c = commits.find(x => x.id === commitId)
  if (!c) throw new Error(`提交不存在: ${commitId}`)
  if (issueIndex >= 0 && issueIndex < c.issues.length) {
    c.issues.splice(issueIndex, 1)
  }
  if ((c.issues || []).length === 0) {
    c.resolved = true
  }
  store.saveCommits(commits)
  return c
}

module.exports = { validate, checkArchiveReadiness, resolveIssue }
