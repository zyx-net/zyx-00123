const store = require('./store')
const config = require('./config')

function classify() {
  const cfg = config.get()
  const commits = store.loadCommits()
  const ticketRe = new RegExp(cfg.ticketPattern, 'i')
  const versionRe = new RegExp(cfg.versionPattern)
  const ignoreRes = (cfg.ignorePatterns || []).map(p => new RegExp(p, 'i'))
  const kwFeature = (cfg.keywords.feature || []).map(k => k.toLowerCase())
  const kwFix = (cfg.keywords.fix || []).map(k => k.toLowerCase())
  const kwBreaking = (cfg.keywords.breaking || []).map(k => k.toLowerCase())

  commits.forEach(c => {
    c.issues = []
    if (c.resolved) return

    const ignored = ignoreRes.some(re => re.test(c.message))
    if (ignored) {
      c.category = 'ignored'
      return
    }

    if (!c.ticket) {
      const m = c.message.match(ticketRe)
      if (m) {
        c.ticket = m[1]
      }
    }

    if (!c.ticket) {
      c.issues.push('缺失工单号')
    }

    const lower = c.message.toLowerCase()
    if (kwBreaking.some(k => lower.includes(k))) {
      c.category = 'breaking'
    } else if (kwFeature.some(k => lower.includes(k))) {
      c.category = 'feature'
    } else if (kwFix.some(k => lower.includes(k))) {
      c.category = 'fix'
    } else {
      c.category = 'other'
    }

    if (c.version && !versionRe.test(c.version)) {
      c.issues.push(`版本号不合规: ${c.version} (应匹配 ${cfg.versionPattern})`)
    }
  })

  store.saveCommits(commits)
  return {
    feature: commits.filter(c => c.category === 'feature' && c.category !== 'ignored').length,
    fix: commits.filter(c => c.category === 'fix' && c.category !== 'ignored').length,
    breaking: commits.filter(c => c.category === 'breaking' && c.category !== 'ignored').length,
    other: commits.filter(c => c.category === 'other' && c.category !== 'ignored').length,
    ignored: commits.filter(c => c.category === 'ignored').length
  }
}

function setCategory(commitId, category) {
  const commits = store.loadCommits()
  const c = commits.find(x => x.id === commitId)
  if (!c) throw new Error(`提交不存在: ${commitId}`)
  c.category = category
  store.saveCommits(commits)
  return c
}

function setVersion(commitId, version) {
  const commits = store.loadCommits()
  const c = commits.find(x => x.id === commitId)
  if (!c) throw new Error(`提交不存在: ${commitId}`)
  const cfg = config.get()
  const versionRe = new RegExp(cfg.versionPattern)
  c.version = version
  if (version && !versionRe.test(version)) {
    c.issues = c.issues.filter(i => !i.startsWith('版本号不合规'))
    c.issues.push(`版本号不合规: ${version} (应匹配 ${cfg.versionPattern})`)
  } else {
    c.issues = c.issues.filter(i => !i.startsWith('版本号不合规'))
  }
  store.saveCommits(commits)
  return c
}

module.exports = { classify, setCategory, setVersion }
