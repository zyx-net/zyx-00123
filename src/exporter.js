const fs = require('fs')
const path = require('path')
const store = require('./store')
const archiver = require('./archiver')

function generateMarkdown(version) {
  const snapshot = archiver.getArchive(version)
  if (!snapshot) throw new Error(`归档不存在: ${version}`)

  const commits = snapshot.commits
  const groups = { breaking: [], feature: [], fix: [], other: [] }
  commits.forEach(c => {
    const cat = c.category || 'other'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(c)
  })

  const lines = []
  lines.push(`# 发布说明 - ${version}`)
  lines.push('')
  lines.push(`> 归档时间: ${snapshot.date}`)
  lines.push(`> 提交数量: ${snapshot.commitCount}`)
  lines.push('')

  if (groups.breaking.length > 0) {
    lines.push('## ⚠ 破坏性变更')
    lines.push('')
    groups.breaking.forEach(c => {
      lines.push(formatCommit(c))
    })
    lines.push('')
  }

  if (groups.feature.length > 0) {
    lines.push('## ✨ 新功能')
    lines.push('')
    groups.feature.forEach(c => {
      lines.push(formatCommit(c))
    })
    lines.push('')
  }

  if (groups.fix.length > 0) {
    lines.push('## 🐛 修复')
    lines.push('')
    groups.fix.forEach(c => {
      lines.push(formatCommit(c))
    })
    lines.push('')
  }

  if (groups.other.length > 0) {
    lines.push('## 📋 其他')
    lines.push('')
    groups.other.forEach(c => {
      lines.push(formatCommit(c))
    })
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('## 来源提交详情')
  lines.push('')
  commits.forEach(c => {
    lines.push(`- **${c.id.substring(0, 8)}** | ${c.message} | ${c.author} | ${c.date}${c.ticket ? ` | 工单: ${c.ticket}` : ''}`)
  })
  lines.push('')

  return lines.join('\n')
}

function formatCommit(c) {
  const ticket = c.ticket ? ` [${c.ticket}]` : ''
  const note = c.note ? ` — *${c.note}*` : ''
  const hash = c.hash ? ` (${c.hash.substring(0, 8)})` : ''
  return `- ${c.message}${ticket}${hash}${note}`
}

function exportToFile(version, outputDir) {
  const md = generateMarkdown(version)
  const dir = outputDir || path.join(store.DATA_DIR, '..', 'output')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const fp = path.join(dir, `release-${version}.md`)
  fs.writeFileSync(fp, md, 'utf-8')
  return fp
}

function exportAll(outputDir) {
  const archives = archiver.listArchives()
  const files = []
  archives.forEach(a => {
    const fp = exportToFile(a.version, outputDir)
    files.push(fp)
  })
  return files
}

module.exports = { generateMarkdown, exportToFile, exportAll }
