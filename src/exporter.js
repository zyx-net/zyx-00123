const fs = require('fs')
const path = require('path')
const store = require('./store')
const archiver = require('./archiver')
const exportProfile = require('./exportProfile')

function renderTitle(template, version) {
  if (!template) return `发布说明 - ${version}`
  return template.replace(/\$\{version\}/g, version)
}

function generateMarkdown(version, profile) {
  const snapshot = archiver.getArchive(version)
  if (!snapshot) throw new Error(`归档不存在: ${version}`)

  const effectiveProfile = profile
    ? exportProfile.normalizeProfile(profile)
    : exportProfile.getDefaultProfileObj()

  const commits = snapshot.commits
  const groups = { breaking: [], feature: [], fix: [], other: [] }
  commits.forEach(c => {
    const cat = c.category || 'other'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(c)
  })

  const lines = []
  const title = renderTitle(effectiveProfile.titleTemplate, version)
  lines.push(`# ${title}`)
  lines.push('')

  const metaLines = []
  if (effectiveProfile.includeDate) {
    metaLines.push(`归档时间: ${snapshot.date}`)
  }
  metaLines.push(`提交数量: ${snapshot.commitCount}`)
  if (metaLines.length > 0) {
    lines.push(`> ${metaLines.join(' | ')}`)
    lines.push('')
  }

  const groupOrder = effectiveProfile.groupOrder && effectiveProfile.groupOrder.length > 0
    ? effectiveProfile.groupOrder
    : exportProfile.DEFAULT_GROUP_ORDER

  groupOrder.forEach(cat => {
    const list = groups[cat]
    if (!list || list.length === 0) return
    const label = exportProfile.CATEGORY_LABELS[cat] || cat
    lines.push(`## ${label}`)
    lines.push('')
    list.forEach(c => {
      lines.push(formatCommit(c, effectiveProfile))
    })
    lines.push('')
  })

  lines.push('---')
  lines.push('')
  lines.push('## 来源提交详情')
  lines.push('')
  commits.forEach(c => {
    const parts = []
    parts.push(`- **${c.id.substring(0, 8)}**`)
    parts.push(c.message)
    if (effectiveProfile.includeAuthor) parts.push(c.author)
    if (effectiveProfile.includeDate) parts.push(c.date)
    if (effectiveProfile.includeTicket && c.ticket) parts.push(`工单: ${c.ticket}`)
    lines.push(parts.join(' | '))
  })
  lines.push('')

  return lines.join('\n')
}

function formatCommit(c, profile) {
  const parts = []
  parts.push(c.message)
  if (profile && profile.includeTicket && c.ticket) {
    parts.push(`[${c.ticket}]`)
  }
  if (profile && profile.includeAuthor && c.author) {
    parts.push(`(${c.author})`)
  }
  if (c.hash) {
    parts.push(`(${c.hash.substring(0, 8)})`)
  }
  if (c.note) {
    parts.push(`— *${c.note}*`)
  }
  return `- ${parts.join(' ')}`
}

function resolveProfile(options) {
  options = options || {}
  if (options.profileId) {
    const p = exportProfile.getProfile(options.profileId)
    if (!p) throw new Error(`方案不存在: ${options.profileId}`)
    return p
  }
  if (options.profileName) {
    const p = exportProfile.getProfileByName(options.profileName)
    if (!p) throw new Error(`方案不存在: ${options.profileName}`)
    return p
  }
  if (options.profile) {
    return exportProfile.normalizeProfile(options.profile)
  }
  return exportProfile.getDefaultProfileObj()
}

function resolveEffectiveOutputDir(profile, explicitDir) {
  if (explicitDir) return explicitDir
  return exportProfile.resolveOutputDir(profile)
}

function exportToFile(version, outputDir, options) {
  options = options || {}
  const profile = resolveProfile(options)
  const dir = resolveEffectiveOutputDir(profile, outputDir)
  const writeCheck = exportProfile.checkOutputWritable(dir)
  if (!writeCheck.writable) {
    throw new Error(writeCheck.errors.join('; ') || `输出目录不可写: ${dir}`)
  }
  const md = generateMarkdown(version, profile)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const fp = path.join(dir, `release-${version}.md`)
  fs.writeFileSync(fp, md, 'utf-8')
  return { path: fp, profileId: profile.id, profileName: profile.name }
}

function exportAll(outputDir, options) {
  options = options || {}
  const profile = resolveProfile(options)
  const archives = archiver.listArchives()
  const files = []
  archives.forEach(a => {
    const r = exportToFile(a.version, outputDir, { profile })
    files.push(r)
  })
  return files
}

module.exports = {
  generateMarkdown,
  formatCommit,
  exportToFile,
  exportAll,
  resolveProfile,
  resolveEffectiveOutputDir
}
