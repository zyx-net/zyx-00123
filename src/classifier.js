const store = require('./store')
const config = require('./config')
const undo = require('./undo')

function classify() {
  undo.push('classify', '自动分类')
  const cfg = config.get()
  const commits = store.loadCommits()
  const ticketRe = new RegExp(cfg.ticketPattern, 'i')
  const versionRe = new RegExp(cfg.versionPattern)
  const ignoreRes = (cfg.ignorePatterns || []).map(p => new RegExp(p, 'i'))
  const kwFeature = (cfg.keywords.feature || []).map(k => k.toLowerCase())
  const kwFix = (cfg.keywords.fix || []).map(k => k.toLowerCase())
  const kwBreaking = (cfg.keywords.breaking || []).map(k => k.toLowerCase())

  commits.forEach(c => {
    if (c.category === 'ignored') return

    const ignored = ignoreRes.some(re => re.test(c.message))
    if (ignored) {
      c.category = 'ignored'
      c.issues = []
      return
    }

    if (!c.ticket) {
      const m = c.message.match(ticketRe)
      if (m) {
        c.ticket = m[1]
        c.issues = (c.issues || []).filter(i => i !== '缺失工单号')
      }
    }

    if (!c.ticket && !c.issues.includes('缺失工单号')) {
      c.issues = c.issues || []
      c.issues.push('缺失工单号')
    }

    const lower = c.message.toLowerCase()
    let newCategory = 'other'
    if (kwBreaking.some(k => lower.includes(k))) newCategory = 'breaking'
    else if (kwFeature.some(k => lower.includes(k))) newCategory = 'feature'
    else if (kwFix.some(k => lower.includes(k))) newCategory = 'fix'
    if (!c.reviewed || c.category === '') {
      c.category = newCategory
    }

    const badVerMsg = c.version ? `版本号不合规: ${c.version} (应匹配 ${cfg.versionPattern})` : ''
    c.issues = (c.issues || []).filter(i => !i.startsWith('版本号不合规'))
    if (c.version && !versionRe.test(c.version)) {
      c.issues.push(badVerMsg)
    }

    if ((c.issues || []).length === 0) {
      c.resolved = true
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
  undo.push('set-category', `设置 ${commitId.substring(0, 8)} 分类=${category}`)
  const commits = store.loadCommits()
  const c = commits.find(x => x.id === commitId)
  if (!c) throw new Error(`提交不存在: ${commitId}`)
  c.category = category
  store.saveCommits(commits)
  return c
}

function setVersion(commitId, version) {
  undo.push('set-version', `设置 ${commitId.substring(0, 8)} 版本=${version}`)
  const commits = store.loadCommits()
  const c = commits.find(x => x.id === commitId)
  if (!c) throw new Error(`提交不存在: ${commitId}`)
  const cfg = config.get()
  const versionRe = new RegExp(cfg.versionPattern)
  c.version = version
  c.issues = (c.issues || []).filter(i => !i.startsWith('版本号不合规'))
  if (version && !versionRe.test(version)) {
    c.issues.push(`版本号不合规: ${version} (应匹配 ${cfg.versionPattern})`)
  }
  if ((c.issues || []).length === 0) c.resolved = true
  else c.resolved = false
  store.saveCommits(commits)
  return c
}

module.exports = { classify, setCategory, setVersion }
