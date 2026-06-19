const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const store = require('./store')
const undo = require('./undo')

function parseGitLog(gitDir) {
  const cwd = gitDir || '.'
  let log
  try {
    log = execSync(
      'git log --pretty=format:"%H|||%s|||%an|||%ai"',
      { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    )
  } catch (e) {
    throw new Error(`执行 git log 失败: ${e.message}`)
  }
  return log.trim().split('\n').filter(Boolean).map(line => {
    const [hash, message, author, date] = line.split('|||')
    return {
      id: hash,
      hash,
      message: (message || '').trim(),
      author: (author || '').trim(),
      date: (date || '').trim(),
      ticket: '',
      version: '',
      category: '',
      note: '',
      source: 'git',
      reviewed: false,
      resolved: false,
      issues: []
    }
  })
}

function parseCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV 文件不存在: ${filePath}`)
  }
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) {
    throw new Error('CSV 文件至少需要包含表头和一行数据')
  }
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
  const idxHash = headers.indexOf('hash')
  const idxMessage = headers.indexOf('message')
  const idxAuthor = headers.indexOf('author')
  const idxDate = headers.indexOf('date')
  const idxTicket = headers.indexOf('ticket')
  const idxVersion = headers.indexOf('version')
  if (idxMessage === -1) {
    throw new Error('CSV 必须包含 message 列')
  }
  return lines.slice(1).map((line, lineNo) => {
    const cols = line.split(',').map(c => c.trim())
    return {
      id: (idxHash >= 0 && cols[idxHash]) || `csv-${lineNo + 1}`,
      hash: (idxHash >= 0 && cols[idxHash]) || '',
      message: cols[idxMessage] || '',
      author: (idxAuthor >= 0 && cols[idxAuthor]) || '',
      date: (idxDate >= 0 && cols[idxDate]) || '',
      ticket: (idxTicket >= 0 && cols[idxTicket]) || '',
      version: (idxVersion >= 0 && cols[idxVersion]) || '',
      category: '',
      note: '',
      source: 'csv',
      reviewed: false,
      resolved: false,
      issues: []
    }
  })
}

function importFromGit(gitDir) {
  const commits = parseGitLog(gitDir)
  undo.push('import', `从 git 导入 (${gitDir || '.'})`)
  return mergeCommits(commits)
}

function importFromCsv(filePath) {
  const commits = parseCsv(filePath)
  undo.push('import', `从 CSV 导入 (${filePath})`)
  return mergeCommits(commits)
}

function mergeCommits(newCommits) {
  const existing = store.loadCommits()
  const existingIds = new Set(existing.map(c => c.id))
  const batchSeen = new Set()
  const duplicates = []
  const added = []
  newCommits.forEach(c => {
    if (existingIds.has(c.id)) {
      duplicates.push(c)
      return
    }
    if (batchSeen.has(c.id)) {
      duplicates.push(c)
      return
    }
    batchSeen.add(c.id)
    added.push(c)
  })
  const merged = existing.concat(added)
  store.saveCommits(merged)
  return { added: added.length, duplicates: duplicates.length, total: merged.length }
}

module.exports = { importFromGit, importFromCsv, parseGitLog, parseCsv }
