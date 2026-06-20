const API = ''

async function api(path, method, body) {
  const opts = {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json' }
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(API + path, opts)
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

function showResult(elId, msg, type) {
  const el = document.getElementById(elId)
  el.className = 'result-box ' + (type || '')
  el.textContent = msg
  el.classList.remove('hidden')
}

function hideResult(elId) {
  document.getElementById(elId).classList.add('hidden')
}

function badgeClass(category) {
  const map = { feature: 'badge-feature', fix: 'badge-fix', breaking: 'badge-breaking', other: 'badge-other', ignored: 'badge-ignored' }
  return map[category] || 'badge-other'
}

function badgeLabel(category) {
  const map = { feature: '功能', fix: '修复', breaking: '破坏性', other: '其他', ignored: '已忽略' }
  return map[category] || category
}

function shortId(id) {
  return id ? id.substring(0, 8) : ''
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active')
    if (btn.dataset.tab === 'review') {
      loadUnreviewed()
      loadUnresolved()
      loadUndoPeek()
    }
    if (btn.dataset.tab === 'archive') {
      loadArchives()
      loadExportVersions()
    }
    if (btn.dataset.tab === 'config') {
      loadConfig()
      loadBackups()
      peekRestoreUndo()
      loadRestoreLogs()
    }
    if (btn.dataset.tab === 'profiles') {
      loadProfiles()
      loadProfileLogs()
      peekProfileUndo()
      loadQuickExportVersions()
      loadQuickExportProfiles()
    }
    if (btn.dataset.tab === 'drafts') {
      loadDrafts()
      loadDraftLogs()
      peekDraftUndo()
    }
  })
})

async function importGit() {
  try {
    const dir = document.getElementById('gitDir').value || '.'
    const result = await api('/api/import/git', 'POST', { dir })
    showResult('importResult', `导入完成: 新增 ${result.added} 条, 重复 ${result.duplicates} 条, 共 ${result.total} 条`, result.duplicates > 0 ? 'warning' : 'success')
  } catch (e) {
    showResult('importResult', '导入失败: ' + e.message, 'error')
  }
}

async function importCsv() {
  try {
    const file = document.getElementById('csvFile').value
    if (!file) return alert('请输入 CSV 文件路径')
    const result = await api('/api/import/csv', 'POST', { file })
    showResult('importResult', `导入完成: 新增 ${result.added} 条, 重复 ${result.duplicates} 条, 共 ${result.total} 条`, result.duplicates > 0 ? 'warning' : 'success')
  } catch (e) {
    showResult('importResult', '导入失败: ' + e.message, 'error')
  }
}

async function runClassify() {
  try {
    const result = await api('/api/classify', 'POST')
    showResult('classifyResult',
      `分类完成: 功能=${result.feature} 修复=${result.fix} 破坏性=${result.breaking} 其他=${result.other} 忽略=${result.ignored}`,
      'success')
    loadCommits()
  } catch (e) {
    showResult('classifyResult', '分类失败: ' + e.message, 'error')
  }
}

async function runValidate() {
  try {
    const result = await api('/api/validate', 'GET')
    if (result.errors.length === 0 && result.warnings.length === 0) {
      showResult('validateResult', '校验通过，无异常', 'success')
    } else {
      let msg = ''
      if (result.errors.length > 0) {
        msg += '错误:\n' + result.errors.map(e => '  ' + e.message).join('\n') + '\n'
      }
      if (result.warnings.length > 0) {
        msg += '警告:\n' + result.warnings.map(w => '  ' + w.message).join('\n')
      }
      showResult('validateResult', msg, result.errors.length > 0 ? 'error' : 'warning')
    }
  } catch (e) {
    showResult('validateResult', '校验失败: ' + e.message, 'error')
  }
}

async function loadCommits() {
  const cat = document.getElementById('categoryFilter').value
  try {
    const commits = await api('/api/commits?category=' + cat)
    const el = document.getElementById('commitsList')
    if (commits.length === 0) {
      el.innerHTML = '<p style="color:#999">暂无提交记录</p>'
      return
    }
    el.innerHTML = commits.map(c => renderCommitItem(c)).join('')
  } catch (e) {
    document.getElementById('commitsList').innerHTML = '<p style="color:#e74c3c">加载失败: ' + e.message + '</p>'
  }
}

function renderCommitItem(c) {
  const cls = (c.issues && c.issues.length > 0 && !c.resolved) ? 'commit-item has-issues' : (c.reviewed ? 'commit-item reviewed' : 'commit-item')
  let html = `<div class="${cls}" data-id="${c.id}">`
  html += `<div class="commit-header">`
  html += `<span class="commit-msg">${escHtml(c.message)}</span>`
  html += `<span class="commit-badge ${badgeClass(c.category)}">${badgeLabel(c.category)}</span>`
  html += `</div>`
  html += `<div class="commit-meta">`
  html += `<span>ID: ${shortId(c.id)}</span>`
  if (c.ticket) html += `<span>工单: ${escHtml(c.ticket)}</span>`
  if (c.version) html += `<span>版本: ${escHtml(c.version)}</span>`
  if (c.note) html += `<span>备注: ${escHtml(c.note)}</span>`
  html += `<span>来源: ${c.source}</span>`
  html += `<span>${c.author}</span>`
  html += `<span>${c.date}</span>`
  html += `</div>`
  if (c.issues && c.issues.length > 0 && !c.resolved) {
    html += `<div class="commit-issues">`
    c.issues.forEach((issue, i) => {
      html += `<span class="issue-item">⚠ ${escHtml(issue)} <button onclick="resolveIssue('${c.id}', ${i})">解决</button></span>`
    })
    html += `</div>`
  }
  html += `<div class="commit-actions">`
  html += `<button onclick="openEditModal('${c.id}')">编辑</button>`
  if (!c.reviewed) {
    html += `<button onclick="reviewCommit('${c.id}')">复核通过</button>`
  } else {
    html += `<button onclick="unreviewCommit('${c.id}')" class="secondary">撤销复核</button>`
  }
  html += `</div>`
  html += `</div>`
  return html
}

function escHtml(s) {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function reviewCommit(id) {
  const note = prompt('输入复核备注 (可留空):')
  if (note === null) return
  try {
    await api('/api/commits/review', 'POST', { id, note })
    loadCommits()
  } catch (e) {
    alert('复核失败: ' + e.message)
  }
}

async function unreviewCommit(id) {
  try {
    await api('/api/commits/unreview', 'POST', { id })
    loadCommits()
  } catch (e) {
    alert('撤销复核失败: ' + e.message)
  }
}

async function resolveIssue(id, index) {
  try {
    await api('/api/commits/resolve', 'POST', { id, issueIndex: index })
    loadCommits()
    loadUnresolved()
  } catch (e) {
    alert('解决失败: ' + e.message)
  }
}

function openEditModal(id) {
  const modal = document.getElementById('commitModal')
  const body = document.getElementById('modalBody')
  document.getElementById('modalTitle').textContent = '编辑提交 ' + shortId(id)
  body.innerHTML = `
    <div class="form-group">
      <label>分类</label>
      <select id="editCategory">
        <option value="feature">功能</option>
        <option value="fix">修复</option>
        <option value="breaking">破坏性变更</option>
        <option value="other">其他</option>
        <option value="ignored">已忽略</option>
      </select>
    </div>
    <div class="form-group">
      <label>目标版本号</label>
      <input type="text" id="editVersion" placeholder="例如: v1.2.0">
    </div>
    <div class="form-group">
      <label>工单号</label>
      <input type="text" id="editTicket" placeholder="例如: PROJ-101">
    </div>
    <div class="form-group">
      <label>复核备注</label>
      <input type="text" id="editNote" placeholder="补充说明">
    </div>
    <button onclick="saveEdit('${id}')">保存</button>
    <button onclick="closeModal()" class="secondary">取消</button>
  `
  modal.classList.remove('hidden')
}

function closeModal() {
  document.getElementById('commitModal').classList.add('hidden')
}

async function saveEdit(id) {
  try {
    const category = document.getElementById('editCategory').value
    const version = document.getElementById('editVersion').value
    const ticket = document.getElementById('editTicket').value
    const note = document.getElementById('editNote').value
    if (category) await api('/api/commits/category', 'POST', { id, category })
    if (version) await api('/api/commits/version', 'POST', { id, version })
    if (ticket) await api('/api/commits/ticket', 'POST', { id, ticket })
    if (note) await api('/api/commits/review', 'POST', { id, note })
    closeModal()
    loadCommits()
  } catch (e) {
    alert('保存失败: ' + e.message)
  }
}

async function loadUnreviewed() {
  try {
    const list = await api('/api/unreviewed')
    const el = document.getElementById('unreviewedList')
    if (list.length === 0) {
      el.innerHTML = '<p style="color:#27ae60">全部已复核 ✓</p>'
      return
    }
    el.innerHTML = list.map(c => `
      <div class="commit-item">
        <div class="commit-msg">${escHtml(c.message)}</div>
        <div class="commit-meta"><span>${shortId(c.id)}</span><span>${c.category}</span><span>来源: ${c.source}</span></div>
        <div class="commit-actions">
          <button onclick="reviewCommit('${c.id}')">复核通过</button>
          <button onclick="batchReviewAll()" class="secondary">全部复核</button>
        </div>
      </div>
    `).join('')
  } catch (e) {
    document.getElementById('unreviewedList').innerHTML = '<p style="color:#e74c3c">加载失败</p>'
  }
}

async function batchReviewAll() {
  try {
    const list = await api('/api/unreviewed')
    const ids = list.map(c => c.id)
    if (ids.length === 0) return
    const note = prompt('批量复核备注 (可留空):')
    if (note === null) return
    await api('/api/commits/review', 'POST', { ids, note })
    loadUnreviewed()
  } catch (e) {
    alert('批量复核失败: ' + e.message)
  }
}

async function loadUnresolved() {
  try {
    const list = await api('/api/unresolved')
    const el = document.getElementById('unresolvedList')
    if (list.length === 0) {
      el.innerHTML = '<p style="color:#27ae60">无未解决问题 ✓</p>'
      return
    }
    el.innerHTML = list.map(c => {
      const issues = c.issues.map((issue, i) =>
        `<span class="issue-item">⚠ ${escHtml(issue)} <button onclick="resolveIssue('${c.id}', ${i})">解决</button></span>`
      ).join('')
      return `
        <div class="commit-item has-issues">
          <div class="commit-msg">${escHtml(c.message)}</div>
          <div class="commit-meta"><span>${shortId(c.id)}</span></div>
          <div class="commit-issues">${issues}</div>
        </div>
      `
    }).join('')
  } catch (e) {
    document.getElementById('unresolvedList').innerHTML = '<p style="color:#e74c3c">加载失败</p>'
  }
}

async function loadUndoPeek() {
  try {
    const peek = await api('/api/undo/peek')
    const size = await api('/api/undo/size')
    const el = document.getElementById('undoPeek')
    if (!peek) {
      el.textContent = `撤销栈为空 (深度: ${size.size})`
    } else {
      el.textContent = `可撤销: [${peek.type}] ${peek.description} (${peek.timestamp}) [栈深度: ${size.size}]`
    }
  } catch {
    document.getElementById('undoPeek').textContent = '加载失败'
  }
}

async function doUndo() {
  if (!confirm('确定撤销上一步操作？')) return
  try {
    const result = await api('/api/undo', 'POST')
    if (!result.success) {
      alert('撤销失败: ' + result.reason)
    } else {
      alert(`已撤销: [${result.action}] ${result.description}`)
      loadUndoPeek()
      loadCommits()
    }
  } catch (e) {
    alert('撤销失败: ' + e.message)
  }
}

async function archiveVersion() {
  const version = document.getElementById('archiveVersion').value.trim()
  if (!version) return alert('请输入版本号')
  try {
    const snapshot = await api('/api/archive', 'POST', { version })
    showResult('archiveResult', `已归档版本 ${version}: ${snapshot.commitCount} 条提交`, 'success')
    loadArchives()
    loadExportVersions()
    document.getElementById('archiveVersion').value = ''
  } catch (e) {
    showResult('archiveResult', '归档失败: ' + e.message, 'error')
  }
}

async function loadArchives() {
  try {
    const list = await api('/api/archives')
    const el = document.getElementById('archivesList')
    if (list.length === 0) {
      el.innerHTML = '<p style="color:#999">尚无已归档版本</p>'
      return
    }
    el.innerHTML = list.map(a => `
      <div class="archive-item">
        <div>
          <div class="archive-info">${escHtml(a.version)}</div>
          <div class="archive-meta">${a.date} | ${a.commitCount} 条提交</div>
        </div>
        <div>
          <button onclick="viewArchive('${escHtml(a.version)}')" class="secondary">查看</button>
        </div>
      </div>
    `).join('')
  } catch (e) {
    document.getElementById('archivesList').innerHTML = '<p style="color:#e74c3c">加载失败</p>'
  }
}

async function viewArchive(version) {
  try {
    const snapshot = await api('/api/archive?version=' + encodeURIComponent(version))
    const modal = document.getElementById('commitModal')
    document.getElementById('modalTitle').textContent = `归档 ${version}`
    const groups = { breaking: [], feature: [], fix: [], other: [] }
    snapshot.commits.forEach(c => {
      const cat = c.category || 'other'
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(c)
    })
    let html = `<p>归档时间: ${snapshot.date} | 提交数: ${snapshot.commitCount}</p>`
    const labels = { breaking: '破坏性变更', feature: '新功能', fix: '修复', other: '其他' }
    Object.keys(labels).forEach(cat => {
      if (groups[cat] && groups[cat].length > 0) {
        html += `<h4>${labels[cat]}</h4><ul>`
        groups[cat].forEach(c => {
          html += `<li>${escHtml(c.message)}${c.ticket ? ' [' + escHtml(c.ticket) + ']' : ''}${c.note ? ' — <em>' + escHtml(c.note) + '</em>' : ''} <small>(${shortId(c.id)}, 来源: ${c.source})</small></li>`
        })
        html += `</ul>`
      }
    })
    document.getElementById('modalBody').innerHTML = html
    modal.classList.remove('hidden')
  } catch (e) {
    alert('查看失败: ' + e.message)
  }
}

async function loadExportVersions() {
  try {
    const list = await api('/api/archives')
    const sel = document.getElementById('exportVersion')
    sel.innerHTML = list.map(a => `<option value="${escHtml(a.version)}">${escHtml(a.version)}</option>`).join('')
  } catch {}
}

async function exportMd() {
  const version = document.getElementById('exportVersion').value
  if (!version) return alert('请选择版本')
  try {
    const result = await api('/api/export', 'POST', { version })
    const el = document.getElementById('exportResult')
    el.className = 'result-box success'
    el.innerHTML = `<h4>${version} 发布说明</h4><pre>${escHtml(result.markdown)}</pre>`
    el.classList.remove('hidden')
  } catch (e) {
    showResult('exportResult', '导出失败: ' + e.message, 'error')
  }
}

async function exportFile() {
  const version = document.getElementById('exportVersion').value
  if (!version) return alert('请选择版本')
  try {
    const result = await api('/api/export/file', 'POST', { version })
    showResult('exportResult', '已导出到文件: ' + result.path, 'success')
  } catch (e) {
    showResult('exportResult', '导出失败: ' + e.message, 'error')
  }
}

async function loadConfig() {
  try {
    const cfg = await api('/api/config')
    document.getElementById('cfgTicketPattern').value = cfg.ticketPattern || ''
    document.getElementById('cfgVersionPattern').value = cfg.versionPattern || ''
    document.getElementById('cfgVersionPrefix').value = cfg.versionPrefix || ''
    document.getElementById('cfgIgnorePatterns').value = (cfg.ignorePatterns || []).join(',')
    document.getElementById('cfgKwFeature').value = (cfg.keywords.feature || []).join(',')
    document.getElementById('cfgKwFix').value = (cfg.keywords.fix || []).join(',')
    document.getElementById('cfgKwBreaking').value = (cfg.keywords.breaking || []).join(',')
  } catch {}
}

async function saveConfig() {
  try {
    const body = {
      ticketPattern: document.getElementById('cfgTicketPattern').value,
      versionPattern: document.getElementById('cfgVersionPattern').value,
      versionPrefix: document.getElementById('cfgVersionPrefix').value,
      ignorePatterns: document.getElementById('cfgIgnorePatterns').value.split(',').map(s => s.trim()).filter(Boolean),
      keywords: {
        feature: document.getElementById('cfgKwFeature').value.split(',').map(s => s.trim()).filter(Boolean),
        fix: document.getElementById('cfgKwFix').value.split(',').map(s => s.trim()).filter(Boolean),
        breaking: document.getElementById('cfgKwBreaking').value.split(',').map(s => s.trim()).filter(Boolean)
      }
    }
    await api('/api/config', 'PUT', body)
    showResult('configResult', '配置已保存', 'success')
  } catch (e) {
    showResult('configResult', '保存失败: ' + e.message, 'error')
  }
}

async function resetConfig() {
  if (!confirm('确定恢复默认配置？')) return
  try {
    await api('/api/config/reset', 'POST')
    loadConfig()
    showResult('configResult', '已恢复默认配置', 'success')
  } catch (e) {
    showResult('configResult', '恢复失败: ' + e.message, 'error')
  }
}

async function exportConfigBackup() {
  try {
    const name = document.getElementById('cfgBackupName').value.trim()
    const result = await api('/api/config/backup', 'POST', { name: name || undefined })
    let msg = `配置已备份: ${result.filename}`
    msg += `\n备份ID: ${result.backupId}`
    msg += `\n校验和: ${result.checksum}`
    msg += `\n路径: ${result.path}`
    showResult('configResult', msg, 'success')
    loadBackups()
  } catch (e) {
    showResult('configResult', '备份失败: ' + e.message, 'error')
  }
}

async function loadBackups() {
  try {
    const list = await api('/api/config/backups', 'GET')
    const el = document.getElementById('backupsList')
    if (list.length === 0) {
      el.innerHTML = '<p style="color:#999">暂无备份</p>'
      return
    }
    el.innerHTML = list.map(b => `
      <div class="archive-item">
        <div>
          <div class="archive-info">${escHtml(b.filename)}</div>
          <div class="archive-meta">${b.created} | ${b.size}B</div>
        </div>
        <div>
          <button onclick="previewDiffFromBackup('${escHtml(b.filename)}')" class="secondary">查看差异</button>
          <button onclick="restoreFromBackup('${escHtml(b.filename)}')" class="secondary">恢复此备份</button>
          <button onclick="deleteBackup('${escHtml(b.filename)}')" class="danger">删除</button>
        </div>
      </div>
    `).join('')
  } catch (e) {
    document.getElementById('backupsList').innerHTML = '<p style="color:#e74c3c">加载备份列表失败: ' + e.message + '</p>'
  }
}

async function deleteBackup(filename) {
  if (!confirm('确定删除此备份？')) return
  try {
    await api('/api/config/backups', 'DELETE', { filename })
    loadBackups()
    showResult('configResult', '已删除备份: ' + filename, 'success')
  } catch (e) {
    showResult('configResult', '删除失败: ' + e.message, 'error')
  }
}

async function handleRestoreWithConflictCheck(result, retryFn) {
  if (result.blocked && result.reason === 'conflict') {
    const conflictList = result.conflictFields ? result.conflictFields.join(', ') : ''
    const msg = `⚠ 检测到冲突！\n\n以下字段在备份导出后已被修改：\n${conflictList}\n\n如果继续，将用备份值覆盖当前配置。\n\n是否强制覆盖？`
    if (confirm(msg)) {
      const retryResult = await retryFn(true)
      displayRestoreResult(retryResult)
    } else {
      showResult('restoreResult', '已取消：检测到冲突，未写入配置。可勾选"强制覆盖"后重试。', 'warning')
    }
    return true
  }
  return false
}

async function restoreFromBackup(filename, forceOverride = false) {
  if (!forceOverride && !confirm('确定从此备份恢复配置？当前配置将被覆盖。')) return
  try {
    const force = forceOverride || document.getElementById('cfgRestoreForce').checked
    const dryRun = document.getElementById('cfgRestoreDryRun').checked
    const result = await api('/api/config/restore', 'POST', { filename, force, dryRun })
    const handled = await handleRestoreWithConflictCheck(result, (f) => restoreFromBackup(filename, f))
    if (!handled) displayRestoreResult(result)
  } catch (e) {
    showResult('restoreResult', '恢复失败: ' + e.message, 'error')
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => resolve(e.target.result)
    reader.onerror = reject
    reader.readAsText(file)
  })
}

async function getRestoreInput() {
  const fileInput = document.getElementById('cfgRestoreFile')
  const jsonText = document.getElementById('cfgRestoreJson').value.trim()
  if (fileInput.files && fileInput.files.length > 0) {
    const text = await readFileAsText(fileInput.files[0])
    return JSON.parse(text)
  } else if (jsonText) {
    return JSON.parse(jsonText)
  }
  return null
}

async function validateRestoreInput() {
  try {
    const backupData = await getRestoreInput()
    if (!backupData) {
      showResult('restoreResult', '请选择文件或粘贴 JSON 内容', 'error')
      return
    }
    const result = await api('/api/config/validate', 'POST', { backupData })
    let msg = '校验结果: ' + (result.valid ? '通过' : '失败')
    if (result.info && result.info.length > 0) msg += '\n\n信息:\n' + result.info.map(i => '  ℹ ' + i).join('\n')
    if (result.warnings && result.warnings.length > 0) msg += '\n\n警告:\n' + result.warnings.map(w => '  ⚠ ' + w).join('\n')
    if (result.errors && result.errors.length > 0) msg += '\n\n错误:\n' + result.errors.map(e => '  ✗ ' + e).join('\n')
    showResult('restoreResult', msg, result.valid ? 'success' : 'error')
  } catch (e) {
    showResult('restoreResult', '校验失败: ' + e.message, 'error')
  }
}

async function importConfigBackup(forceOverride = false) {
  try {
    const backupData = await getRestoreInput()
    if (!backupData) {
      showResult('restoreResult', '请选择文件或粘贴 JSON 内容', 'error')
      return
    }
    if (!forceOverride && !confirm('确定从此备份恢复配置？当前配置将被覆盖。')) return
    const force = forceOverride || document.getElementById('cfgRestoreForce').checked
    const dryRun = document.getElementById('cfgRestoreDryRun').checked
    const result = await api('/api/config/restore', 'POST', { backupData, force, dryRun })
    const handled = await handleRestoreWithConflictCheck(result, (f) => {
      window._pendingForceBackupData = backupData
      return importConfigBackup(f)
    })
    if (!handled) displayRestoreResult(result)
  } catch (e) {
    showResult('restoreResult', '恢复失败: ' + e.message, 'error')
  }
}

function displayRestoreResult(result) {
  let msg = ''
  if (result.logs && result.logs.length > 0) msg += '日志:\n' + result.logs.map(l => '  ℹ ' + l).join('\n') + '\n'
  if (result.warnings && result.warnings.length > 0) msg += '警告:\n' + result.warnings.map(w => '  ⚠ ' + w).join('\n') + '\n'
  if (result.errors && result.errors.length > 0) msg += '错误:\n' + result.errors.map(e => '  ✗ ' + e).join('\n') + '\n'
  if (result.success) {
    if (result.skipped) {
      msg += '\n已跳过: ' + (result.reason || '')
      showResult('restoreResult', msg, 'warning')
    } else if (result.dryRun) {
      msg += '\n预览模式，未实际写入'
      if (result.wouldApply && result.wouldApply.length > 0) {
        msg += '\n\n将应用的变更:\n'
        result.wouldApply.forEach(c => { msg += '  - ' + c.field + ': ' + JSON.stringify(c.from) + ' → ' + JSON.stringify(c.to) + '\n' })
      }
      showResult('restoreResult', msg, 'warning')
    } else {
      msg += result.isPartial ? '\n✓ 按项恢复成功' : '\n✓ 配置恢复成功'
      if (result.selectedFields && result.selectedFields.length > 0) {
        msg += '\n已应用字段: ' + result.selectedFields.join(', ')
      }
      if (result.changes && result.changes.length > 0) {
        msg += '\n\n已应用 ' + result.changes.length + ' 处变更'
      }
      showResult('restoreResult', msg, 'success')
      loadConfig()
      peekRestoreUndo()
      loadRestoreLogs()
    }
  } else {
    showResult('restoreResult', msg || '恢复失败', 'error')
  }
}

let currentDiffBackupData = null

async function previewRestoreDiff() {
  try {
    const backupData = await getRestoreInput()
    if (!backupData) {
      showResult('restoreResult', '请选择文件或粘贴 JSON 内容', 'error')
      return
    }
    const result = await api('/api/config/diff', 'POST', { backupData })
    if (!result.success) {
      showResult('restoreResult', '差异对比失败: ' + (result.errors || []).join('; '), 'error')
      return
    }
    if (result.validation) {
      result.validation.info.forEach(i => console.log('[INFO]', i))
      result.validation.warnings.forEach(w => console.warn('[WARN]', w))
      result.validation.errors.forEach(e => console.error('[ERR]', e))
    }
    if (!result.valid) {
      showResult('restoreResult', '备份文件结构不合法', 'error')
      return
    }
    currentDiffBackupData = backupData
    renderDiffPanel(result)
  } catch (e) {
    showResult('restoreResult', '差异对比失败: ' + e.message, 'error')
  }
}

async function previewDiffFromBackup(filename) {
  try {
    const result = await api('/api/config/diff', 'POST', { filename })
    if (!result.success) {
      showResult('configResult', '差异对比失败: ' + (result.errors || []).join('; '), 'error')
      return
    }
    if (!result.valid) {
      showResult('configResult', '备份文件结构不合法', 'error')
      return
    }
    const resolved = await api('/api/config/backups', 'GET')
    const found = resolved.find(b => b.filename === filename)
    currentDiffBackupData = null
    if (found) {
      window._pendingRestoreFilename = filename
    }
    renderDiffPanel(result)
  } catch (e) {
    showResult('configResult', '差异对比失败: ' + e.message, 'error')
  }
}

function renderDiffPanel(diffResult) {
  const panel = document.getElementById('restoreDiffPanel')
  const listEl = document.getElementById('restoreDiffList')
  const dd = diffResult.detailedDiff
  if (!dd.hasChanges) {
    listEl.innerHTML = '<p style="color:#27ae60">备份内容与当前配置完全一致，无差异</p>'
  } else {
    let html = ''
    if (diffResult.conflict && diffResult.conflict.hasConflict) {
      html += `<div style="background:#fff3cd;color:#856404;padding:8px;border-radius:4px;margin-bottom:12px">⚠ 冲突提示: 当前配置在备份导出后已被修改，共 ${diffResult.conflict.changes.length} 处变更</div>`
    }
    dd.fields.forEach((d, idx) => {
      const rowCls = d.changed ? 'diff-row changed' : 'diff-row unchanged'
      let detail = ''
      if (d.changed) {
        if (d.isArray) {
          const removedHtml = d.removed.length > 0 ? `<div class="diff-removed">备份中存在 (将恢复): ${d.removed.map(escHtml).join(', ')}</div>` : ''
          const addedHtml = d.added.length > 0 ? `<div class="diff-added">当前新增 (将被移除): ${d.added.map(escHtml).join(', ')}</div>` : ''
          detail = removedHtml + addedHtml
        } else {
          detail = `<div class="diff-backup">备份值: ${escHtml(JSON.stringify(d.backupValue))}</div>
                    <div class="diff-current">当前值: ${escHtml(JSON.stringify(d.currentValue))}</div>`
        }
      }
      html += `<div class="${rowCls}">
        <label>
          <input type="checkbox" class="diff-field-cb" value="${d.field}" ${d.changed ? 'checked' : ''} ${!d.changed ? 'disabled' : ''}>
          <strong>${d.field}</strong> ${d.changed ? '<span class="diff-badge">[差异]</span>' : '<span class="diff-badge ok">[一致]</span>'}
        </label>
        ${detail ? `<div class="diff-detail">${detail}</div>` : ''}
      </div>`
    })
    listEl.innerHTML = html
  }
  panel.classList.remove('hidden')
}

function cancelPartialRestore() {
  currentDiffBackupData = null
  window._pendingRestoreFilename = null
  document.getElementById('restoreDiffPanel').classList.add('hidden')
}

async function confirmPartialRestore(forceOverride = false) {
  const cbs = document.querySelectorAll('.diff-field-cb:checked')
  const fields = Array.from(cbs).map(cb => cb.value)
  if (fields.length === 0) {
    alert('请至少选择一个要恢复的字段')
    return
  }
  if (!forceOverride && !confirm(`确定恢复选中的 ${fields.length} 个字段？\n字段: ${fields.join(', ')}`)) return
  try {
    const force = forceOverride || document.getElementById('cfgRestoreForce').checked
    const dryRun = document.getElementById('cfgRestoreDryRun').checked
    let result
    if (window._pendingRestoreFilename) {
      result = await api('/api/config/restore', 'POST', { filename: window._pendingRestoreFilename, force, dryRun, fields })
    } else if (currentDiffBackupData) {
      result = await api('/api/config/restore', 'POST', { backupData: currentDiffBackupData, force, dryRun, fields })
    } else {
      showResult('restoreResult', '缺少备份数据', 'error')
      return
    }
    const handled = await handleRestoreWithConflictCheck(result, (f) => confirmPartialRestore(f))
    if (!handled) {
      cancelPartialRestore()
      displayRestoreResult(result)
    }
  } catch (e) {
    showResult('restoreResult', '按项恢复失败: ' + e.message, 'error')
  }
}

async function loadRestoreLogs() {
  try {
    const result = await api('/api/config/restore/logs?limit=20', 'GET')
    const el = document.getElementById('restoreLogsList')
    const logs = result.logs || []
    if (logs.length === 0) {
      el.innerHTML = '<p style="color:#999">暂无恢复操作日志</p>'
      return
    }
    const labels = { full_restore: '整包恢复', partial_restore: '按项恢复', undo_restore: '撤销恢复' }
    el.innerHTML = logs.map(l => {
      const lbl = labels[l.action] || l.action
      const fieldsHtml = l.selectedFields && l.selectedFields.length > 0
        ? `<div class="archive-meta">字段: ${escHtml(l.selectedFields.join(', '))}</div>`
        : ''
      return `<div class="archive-item">
        <div>
          <div class="archive-info">[${lbl}] ${escHtml(l.backupName || l.backupId || '')}</div>
          <div class="archive-meta">${escHtml(l.timestamp)}${l.changes && l.changes.length ? ' | ' + l.changes.length + ' 处变更' : ''}</div>
          ${fieldsHtml}
        </div>
      </div>`
    }).join('')
  } catch (e) {
    document.getElementById('restoreLogsList').innerHTML = '<p style="color:#e74c3c">加载日志失败: ' + escHtml(e.message) + '</p>'
  }
}

async function peekRestoreUndo() {
  try {
    const snap = await api('/api/config/restore/peek', 'GET')
    const el = document.getElementById('restoreUndoInfo')
    if (!snap) {
      el.textContent = '没有可撤销的配置恢复操作'
      el.style.color = '#999'
    } else {
      let txt = '可撤销的恢复操作:\n'
      txt += '  来源: ' + (snap.name || snap.backupId) + '\n'
      txt += '  恢复时间: ' + snap.restoredAt
      el.textContent = txt
      el.style.color = '#333'
    }
  } catch {
    document.getElementById('restoreUndoInfo').textContent = '加载失败'
  }
}

async function undoLastRestore() {
  if (!confirm('确定撤销最近一次配置恢复？')) return
  try {
    const result = await api('/api/config/restore/undo', 'POST')
    let msg = ''
    if (result.logs && result.logs.length > 0) msg += result.logs.join('\n') + '\n'
    if (result.warnings && result.warnings.length > 0) msg += '警告: ' + result.warnings.join('; ') + '\n'
    if (result.errors && result.errors.length > 0) msg += '错误: ' + result.errors.join('; ') + '\n'
    if (result.success) {
      msg += '✓ 已撤销最近一次配置恢复'
      showResult('configResult', msg, 'success')
      loadConfig()
      peekRestoreUndo()
      loadRestoreLogs()
    } else {
      showResult('configResult', msg || result.reason || '撤销失败', 'error')
    }
  } catch (e) {
    showResult('configResult', '撤销失败: ' + e.message, 'error')
  }
}

let currentEditingProfileId = null

async function loadProfiles() {
  try {
    const result = await api('/api/export/profiles', 'GET')
    exportProfilesCache = result.profiles || []
    const el = document.getElementById('profilesList')
    if (exportProfilesCache.length === 0) {
      el.innerHTML = '<p style="color:#999;text-align:center;padding:20px">暂无导出方案，点击"新建方案"创建第一个</p>'
      return
    }
    el.innerHTML = exportProfilesCache.map(p => renderProfileCard(p)).join('')
  } catch (e) {
    document.getElementById('profilesList').innerHTML = '<p style="color:#e74c3c">加载失败: ' + escHtml(e.message) + '</p>'
  }
}

let exportProfilesCache = []

function renderProfileCard(p) {
  const defBadge = p.isDefault ? '<span class="profile-badge default">默认</span>' : ''
  const opts = []
  if (p.includeTicket) opts.push('工单')
  if (p.includeAuthor) opts.push('作者')
  if (p.includeDate) opts.push('日期')
  return `
    <div class="profile-card ${p.isDefault ? 'is-default' : ''}">
      <div class="profile-header">
        <div>
          <strong class="profile-name">${escHtml(p.name)}</strong>
          ${defBadge}
        </div>
        <div class="profile-actions">
          ${!p.isDefault ? '<button onclick="setDefaultProfile(\'' + p.id + '\')" class="secondary small">设为默认</button>' : ''}
          <button onclick="editProfile('${p.id}')" class="secondary small">编辑</button>
          <button onclick="duplicateProfile('${p.id}')" class="secondary small">复制</button>
          <button onclick="exportProfileJson('${p.id}')" class="secondary small">导出</button>
          <button onclick="deleteProfile('${p.id}')" class="danger small">删除</button>
        </div>
      </div>
      <div class="profile-body">
        <div class="profile-info-row">
          <span class="profile-label">标题模板:</span>
          <span class="profile-value">${escHtml(p.titleTemplate)}</span>
        </div>
        <div class="profile-info-row">
          <span class="profile-label">分组顺序:</span>
          <span class="profile-value">${p.groupOrder.map(catLabel).join(' → ')}</span>
        </div>
        <div class="profile-info-row">
          <span class="profile-label">包含项:</span>
          <span class="profile-value">${opts.length > 0 ? opts.join('、') : '无'}</span>
        </div>
        <div class="profile-info-row">
          <span class="profile-label">输出目录:</span>
          <span class="profile-value">${escHtml(p.outputDir) || '(默认)'}</span>
        </div>
        <div class="profile-meta">
          创建: ${escHtml(p.createdAt || '')} | 更新: ${escHtml(p.updatedAt || '')}
        </div>
      </div>
    </div>
  `
}

function catLabel(cat) {
  const map = { breaking: '⚠ 破坏性', feature: '✨ 功能', fix: '🐛 修复', other: '📋 其他' }
  return map[cat] || cat
}

function openProfileModal(profileId) {
  currentEditingProfileId = profileId || null
  const modal = document.getElementById('profileModal')
  const titleEl = document.getElementById('profileModalTitle')
  const resultEl = document.getElementById('profileModalResult')
  resultEl.classList.add('hidden')

  if (profileId) {
    titleEl.textContent = '编辑方案'
    const profile = exportProfilesCache.find(p => p.id === profileId)
    if (profile) {
      document.getElementById('profileName').value = profile.name
      document.getElementById('profileTitleTemplate').value = profile.titleTemplate
      document.getElementById('profileIncludeTicket').checked = profile.includeTicket
      document.getElementById('profileIncludeAuthor').checked = profile.includeAuthor
      document.getElementById('profileIncludeDate').checked = profile.includeDate
      document.getElementById('profileOutputDir').value = profile.outputDir || ''
      setGroupOrder(profile.groupOrder)
    }
  } else {
    titleEl.textContent = '新建方案'
    document.getElementById('profileName').value = ''
    document.getElementById('profileTitleTemplate').value = '发布说明 - ${version}'
    document.getElementById('profileIncludeTicket').checked = true
    document.getElementById('profileIncludeAuthor').checked = false
    document.getElementById('profileIncludeDate').checked = true
    document.getElementById('profileOutputDir').value = ''
    setGroupOrder(['breaking', 'feature', 'fix', 'other'])
  }

  modal.classList.remove('hidden')
  document.getElementById('profileName').focus()
}

function closeProfileModal() {
  document.getElementById('profileModal').classList.add('hidden')
  currentEditingProfileId = null
}

function editProfile(id) {
  openProfileModal(id)
}

function setGroupOrder(order) {
  const container = document.getElementById('groupOrderList')
  const items = Array.from(container.children)
  order.forEach(cat => {
    const item = items.find(it => it.dataset.cat === cat)
    if (item) {
      container.appendChild(item)
      const cb = item.querySelector('.group-cb')
      if (cb) cb.checked = true
    }
  })
  items.forEach(item => {
    const cat = item.dataset.cat
    if (!order.includes(cat)) {
      const cb = item.querySelector('.group-cb')
      if (cb) cb.checked = false
    }
  })
}

function getGroupOrder() {
  const container = document.getElementById('groupOrderList')
  const items = Array.from(container.children)
  return items
    .filter(it => {
      const cb = it.querySelector('.group-cb')
      return cb && cb.checked
    })
    .map(it => it.dataset.cat)
}

async function saveProfile() {
  const name = document.getElementById('profileName').value.trim()
  const resultEl = document.getElementById('profileModalResult')

  if (!name) {
    showResult('profileModalResult', '请输入方案名称', 'error')
    return
  }

  const groupOrder = getGroupOrder()
  if (groupOrder.length === 0) {
    showResult('profileModalResult', '请至少选择一个分组', 'error')
    return
  }

  const profileData = {
    name,
    titleTemplate: document.getElementById('profileTitleTemplate').value,
    groupOrder,
    includeTicket: document.getElementById('profileIncludeTicket').checked,
    includeAuthor: document.getElementById('profileIncludeAuthor').checked,
    includeDate: document.getElementById('profileIncludeDate').checked,
    outputDir: document.getElementById('profileOutputDir').value.trim()
  }

  try {
    let result
    if (currentEditingProfileId) {
      result = await api('/api/export/profiles/' + encodeURIComponent(currentEditingProfileId), 'PUT', profileData)
    } else {
      result = await api('/api/export/profiles', 'POST', profileData)
    }
    showResult('profileModalResult', (currentEditingProfileId ? '更新' : '创建') + '成功: ' + result.profile.name, 'success')
    setTimeout(() => {
      closeProfileModal()
      loadProfiles()
      loadProfileLogs()
      peekProfileUndo()
      loadQuickExportProfiles()
    }, 600)
  } catch (e) {
    if (e.message && (e.message.includes('同名') || e.message.includes('已存在'))) {
      const msg = e.message + '\n\n是否强制覆盖？'
      if (confirm(msg)) {
        try {
          profileData.force = true
          let result
          if (currentEditingProfileId) {
            result = await api('/api/export/profiles/' + encodeURIComponent(currentEditingProfileId), 'PUT', profileData)
          } else {
            result = await api('/api/export/profiles', 'POST', profileData)
          }
          showResult('profileModalResult', '已覆盖同名方案: ' + result.profile.name, 'success')
          setTimeout(() => {
            closeProfileModal()
            loadProfiles()
            loadProfileLogs()
            peekProfileUndo()
            loadQuickExportProfiles()
          }, 600)
        } catch (e2) {
          showResult('profileModalResult', '保存失败: ' + e2.message, 'error')
        }
      }
    } else {
      showResult('profileModalResult', '保存失败: ' + e.message, 'error')
    }
  }
}

async function deleteProfile(id) {
  if (!confirm('确定删除此方案？此操作可撤销。')) return
  try {
    const result = await api('/api/export/profiles/' + encodeURIComponent(id), 'DELETE')
    let msg = '已删除方案'
    if (result.wasDefault) msg += '（被删除的是默认方案）'
    if (result.newDefault) msg += '\n新的默认方案已自动分配'
    showResult('profilesResult', msg, 'success')
    loadProfiles()
    loadProfileLogs()
    peekProfileUndo()
    loadQuickExportProfiles()
  } catch (e) {
    showResult('profilesResult', '删除失败: ' + e.message, 'error')
  }
}

async function setDefaultProfile(id) {
  try {
    const result = await api('/api/export/profiles/default', 'POST', { id })
    showResult('profilesResult', '已设为默认方案', 'success')
    loadProfiles()
    loadProfileLogs()
    peekProfileUndo()
    loadQuickExportProfiles()
  } catch (e) {
    showResult('profilesResult', '设置失败: ' + e.message, 'error')
  }
}

async function duplicateProfile(id) {
  const newName = prompt('输入新方案名称：')
  if (newName === null) return
  const trimmedName = newName.trim()
  if (!trimmedName) {
    alert('请输入方案名称')
    return
  }
  try {
    const result = await api('/api/export/profiles/' + encodeURIComponent(id) + '/duplicate', 'POST', { newName: trimmedName })
    showResult('profilesResult', '已复制方案: ' + result.profile.name, 'success')
    loadProfiles()
    loadProfileLogs()
    peekProfileUndo()
    loadQuickExportProfiles()
  } catch (e) {
    showResult('profilesResult', '复制失败: ' + e.message, 'error')
  }
}

async function exportProfileJson(id) {
  try {
    const result = await api('/api/export/profiles/' + encodeURIComponent(id) + '/export', 'POST')
    const jsonStr = JSON.stringify(result.data, null, 2)
    const blob = new Blob([jsonStr], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'profile-' + (result.data.profile ? (result.data.profile.name || 'export') : 'export') + '.json'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    showResult('profilesResult', '方案已导出为 JSON 文件', 'success')
  } catch (e) {
    showResult('profilesResult', '导出失败: ' + e.message, 'error')
  }
}

function openImportProfileModal() {
  document.getElementById('importProfileModal').classList.remove('hidden')
  document.getElementById('importProfileJson').value = ''
  document.getElementById('importProfileAsName').value = ''
  document.getElementById('importProfileForce').checked = false
  document.getElementById('importProfileResult').classList.add('hidden')
  const fileInput = document.getElementById('importProfileFile')
  if (fileInput) fileInput.value = ''
}

function closeImportProfileModal() {
  document.getElementById('importProfileModal').classList.add('hidden')
}

async function getImportProfileData() {
  const fileInput = document.getElementById('importProfileFile')
  const jsonText = document.getElementById('importProfileJson').value.trim()

  if (fileInput.files && fileInput.files.length > 0) {
    const text = await readFileAsText(fileInput.files[0])
    return JSON.parse(text)
  } else if (jsonText) {
    return JSON.parse(jsonText)
  }
  return null
}

async function doValidateImport() {
  try {
    const data = await getImportProfileData()
    if (!data) {
      showResult('importProfileResult', '请选择文件或粘贴 JSON 内容', 'error')
      return
    }
    const result = await api('/api/export/profiles/validate', 'POST', { profileData: data })
    let msg = '校验结果: ' + (result.valid ? '通过' : '失败')
    if (result.info && result.info.length > 0) msg += '\n信息:\n' + result.info.map(i => '  ℹ ' + i).join('\n')
    if (result.warnings && result.warnings.length > 0) msg += '\n警告:\n' + result.warnings.map(w => '  ⚠ ' + w).join('\n')
    if (result.errors && result.errors.length > 0) msg += '\n错误:\n' + result.errors.map(e => '  ✗ ' + e).join('\n')
    showResult('importProfileResult', msg, result.valid ? 'success' : 'error')
  } catch (e) {
    showResult('importProfileResult', '校验失败: ' + e.message, 'error')
  }
}

async function doImportProfile() {
  try {
    const data = await getImportProfileData()
    if (!data) {
      showResult('importProfileResult', '请选择文件或粘贴 JSON 内容', 'error')
      return
    }
    const asName = document.getElementById('importProfileAsName').value.trim()
    const force = document.getElementById('importProfileForce').checked
    const body = { profileData: data, force }
    if (asName) body.asName = asName

    const result = await api('/api/export/profiles/import', 'POST', body)
    showResult('importProfileResult', '导入成功: ' + result.profile.name, 'success')
    setTimeout(() => {
      closeImportProfileModal()
      loadProfiles()
      loadProfileLogs()
      peekProfileUndo()
      loadQuickExportProfiles()
    }, 600)
  } catch (e) {
    if (e.message && (e.message.includes('同名') || e.message.includes('已存在'))) {
      const msg = e.message + '\n\n是否强制覆盖？'
      if (confirm(msg)) {
        try {
          const data = await getImportProfileData()
          const asName = document.getElementById('importProfileAsName').value.trim()
          const body = { profileData: data, force: true }
          if (asName) body.asName = asName
          const result = await api('/api/export/profiles/import', 'POST', body)
          showResult('importProfileResult', '已覆盖同名方案: ' + result.profile.name, 'success')
          setTimeout(() => {
            closeImportProfileModal()
            loadProfiles()
            loadProfileLogs()
            peekProfileUndo()
            loadQuickExportProfiles()
          }, 600)
        } catch (e2) {
          showResult('importProfileResult', '导入失败: ' + e2.message, 'error')
        }
      }
    } else {
      showResult('importProfileResult', '导入失败: ' + e.message, 'error')
    }
  }
}

async function loadProfileLogs() {
  try {
    const result = await api('/api/export/profiles/logs?limit=20', 'GET')
    const logs = result.logs || []
    const el = document.getElementById('profileLogsList')
    if (logs.length === 0) {
      el.innerHTML = '<p style="color:#999">暂无操作日志</p>'
      return
    }
    const actionLabels = { create: '创建', update: '更新', delete: '删除', set_default: '设默认', duplicate: '复制', undo: '撤销', import: '导入', export: '导出' }
    el.innerHTML = logs.map(l => {
      const lbl = actionLabels[l.action] || l.action
      return `
        <div class="log-item">
          <span class="log-action">[${lbl}]</span>
          <span class="log-name">${escHtml(l.profileName || l.description || '')}</span>
          <span class="log-time">${escHtml(l.timestamp || '')}</span>
        </div>
      `
    }).join('')
  } catch (e) {
    document.getElementById('profileLogsList').innerHTML = '<p style="color:#e74c3c">加载失败</p>'
  }
}

async function peekProfileUndo() {
  try {
    const snap = await api('/api/export/profiles/undo/peek', 'GET')
    const el = document.getElementById('profileUndoInfo')
    if (!snap || !snap.description) {
      el.textContent = '没有可撤销的方案操作'
      el.style.color = '#999'
    } else {
      el.textContent = '可撤销: ' + snap.description + ' (' + snap.timestamp + ')'
      el.style.color = '#333'
    }
  } catch {
    document.getElementById('profileUndoInfo').textContent = '加载失败'
  }
}

async function undoProfileChange() {
  if (!confirm('确定撤销最近一次方案操作？')) return
  try {
    const result = await api('/api/export/profiles/undo', 'POST')
    let msg = '已撤销'
    if (result.description) msg += ': ' + result.description
    showResult('profilesResult', msg, 'success')
    loadProfiles()
    loadProfileLogs()
    peekProfileUndo()
    loadQuickExportProfiles()
  } catch (e) {
    showResult('profilesResult', '撤销失败: ' + e.message, 'error')
  }
}

async function loadQuickExportProfiles() {
  try {
    const result = await api('/api/export/profiles', 'GET')
    exportProfilesCache = result.profiles || []
    const sel = document.getElementById('quickExportProfile')
    let html = '<option value="">默认方案</option>'
    exportProfilesCache.forEach(p => {
      const defMark = p.isDefault ? ' [默认]' : ''
      html += `<option value="${escHtml(p.id)}">${escHtml(p.name)}${defMark}</option>`
    })
    sel.innerHTML = html
    const defP = exportProfilesCache.find(p => p.isDefault)
    if (defP) sel.value = defP.id
  } catch {}
}

async function loadQuickExportVersions() {
  try {
    const list = await api('/api/archives')
    const sel = document.getElementById('quickExportVersion')
    if (list.length === 0) {
      sel.innerHTML = '<option value="">暂无已归档版本</option>'
      return
    }
    sel.innerHTML = list.map(a => `<option value="${escHtml(a.version)}">${escHtml(a.version)}</option>`).join('')
  } catch {}
}

async function quickPreviewExport() {
  const version = document.getElementById('quickExportVersion').value
  const profileId = document.getElementById('quickExportProfile').value
  if (!version) {
    alert('请选择已归档版本')
    return
  }
  try {
    const body = { version }
    if (profileId) body.profileId = profileId
    const result = await api('/api/export', 'POST', body)
    const el = document.getElementById('quickExportResult')
    el.className = 'result-box success'
    el.innerHTML = `<h4>${escHtml(version)} 发布说明 ${result.profileName ? '(' + escHtml(result.profileName) + ')' : ''}</h4><pre style="max-height:400px;overflow:auto">${escHtml(result.markdown)}</pre>`
    el.classList.remove('hidden')
  } catch (e) {
    showResult('quickExportResult', '预览失败: ' + e.message, 'error')
  }
}

async function quickExportToFile() {
  const version = document.getElementById('quickExportVersion').value
  const profileId = document.getElementById('quickExportProfile').value
  if (!version) {
    alert('请选择已归档版本')
    return
  }
  try {
    const body = { version }
    if (profileId) body.profileId = profileId
    const result = await api('/api/export/file', 'POST', body)
    showResult('quickExportResult', '已导出到文件: ' + result.path, 'success')
  } catch (e) {
    showResult('quickExportResult', '导出失败: ' + e.message, 'error')
  }
}

let draftsCache = []
let currentEditingDraftId = null

async function loadDrafts() {
  try {
    const result = await api('/api/drafts', 'GET')
    draftsCache = result.drafts || []
    const el = document.getElementById('draftsList')
    if (draftsCache.length === 0) {
      el.innerHTML = '<p style="color:#999;text-align:center;padding:20px">暂无草稿，点击"新建草稿"或"保存当前状态"创建第一个</p>'
      return
    }
    el.innerHTML = draftsCache.map(d => renderDraftCard(d)).join('')
  } catch (e) {
    document.getElementById('draftsList').innerHTML = '<p style="color:#e74c3c">加载失败: ' + escHtml(e.message) + '</p>'
  }
}

function renderDraftCard(d) {
  return `
    <div class="profile-card">
      <div class="profile-header">
        <div>
          <strong class="profile-name">${escHtml(d.name)}</strong>
          ${d.version ? '<span class="profile-badge">' + escHtml(d.version) + '</span>' : ''}
        </div>
        <div class="profile-actions">
          <button onclick="viewDraft('${d.id}')" class="secondary small">查看</button>
          <button onclick="applyDraft('${d.id}')" class="secondary small">应用</button>
          <button onclick="editDraft('${d.id}')" class="secondary small">编辑</button>
          <button onclick="duplicateDraft('${d.id}')" class="secondary small">复制</button>
          <button onclick="exportDraftJson('${d.id}')" class="secondary small">导出</button>
          <button onclick="archiveFromDraft('${d.id}')" class="primary small">归档</button>
          <button onclick="deleteDraft('${d.id}')" class="danger small">删除</button>
        </div>
      </div>
      <div class="profile-body">
        <div class="profile-info-row">
          <span class="profile-label">版本号:</span>
          <span class="profile-value">${escHtml(d.version) || '(未设置)'}</span>
        </div>
        <div class="profile-info-row">
          <span class="profile-label">提交数:</span>
          <span class="profile-value">${d.commitCount} 条</span>
        </div>
        <div class="profile-info-row">
          <span class="profile-label">描述:</span>
          <span class="profile-value">${escHtml(d.description) || '(无)'}</span>
        </div>
        ${d.profileName ? '<div class="profile-info-row"><span class="profile-label">导出方案:</span><span class="profile-value">' + escHtml(d.profileName) + '</span></div>' : ''}
        <div class="profile-meta">
          创建: ${escHtml(d.createdAt || '')} | 更新: ${escHtml(d.updatedAt || '')}
        </div>
      </div>
    </div>
  `
}

function openDraftModal(draftId) {
  currentEditingDraftId = draftId || null
  const modal = document.getElementById('draftModal')
  const titleEl = document.getElementById('draftModalTitle')
  const resultEl = document.getElementById('draftModalResult')
  resultEl.classList.add('hidden')

  if (draftId) {
    titleEl.textContent = '编辑草稿'
    const draft = draftsCache.find(d => d.id === draftId)
    if (draft) {
      document.getElementById('draftName').value = draft.name
      document.getElementById('draftVersion').value = draft.version || ''
      document.getElementById('draftDescription').value = draft.description || ''
    }
  } else {
    titleEl.textContent = '新建草稿'
    document.getElementById('draftName').value = ''
    document.getElementById('draftVersion').value = ''
    document.getElementById('draftDescription').value = ''
  }

  modal.classList.remove('hidden')
  document.getElementById('draftName').focus()
}

function closeDraftModal() {
  document.getElementById('draftModal').classList.add('hidden')
  currentEditingDraftId = null
}

function editDraft(id) {
  openDraftModal(id)
}

async function saveDraft() {
  const name = document.getElementById('draftName').value.trim()
  const resultEl = document.getElementById('draftModalResult')

  if (!name) {
    showResult('draftModalResult', '请输入草稿名称', 'error')
    return
  }

  const draftData = {
    name,
    version: document.getElementById('draftVersion').value.trim(),
    description: document.getElementById('draftDescription').value.trim()
  }

  try {
    let result
    if (currentEditingDraftId) {
      result = await api('/api/drafts/' + encodeURIComponent(currentEditingDraftId), 'PUT', draftData)
    } else {
      result = await api('/api/drafts', 'POST', draftData)
    }
    showResult('draftModalResult', (currentEditingDraftId ? '更新' : '创建') + '成功: ' + result.draft.name, 'success')
    setTimeout(() => {
      closeDraftModal()
      loadDrafts()
      loadDraftLogs()
      peekDraftUndo()
    }, 600)
  } catch (e) {
    if (e.message && (e.message.includes('同名') || e.message.includes('同版本'))) {
      const msg = e.message + '\n\n是否强制覆盖？'
      if (confirm(msg)) {
        try {
          draftData.force = true
          let result
          if (currentEditingDraftId) {
            result = await api('/api/drafts/' + encodeURIComponent(currentEditingDraftId), 'PUT', draftData)
          } else {
            result = await api('/api/drafts', 'POST', draftData)
          }
          showResult('draftModalResult', '已覆盖: ' + result.draft.name, 'success')
          setTimeout(() => {
            closeDraftModal()
            loadDrafts()
            loadDraftLogs()
            peekDraftUndo()
          }, 600)
        } catch (e2) {
          showResult('draftModalResult', '保存失败: ' + e2.message, 'error')
        }
      }
    } else {
      showResult('draftModalResult', '保存失败: ' + e.message, 'error')
    }
  }
}

async function deleteDraft(id) {
  if (!confirm('确定删除此草稿？此操作可撤销。')) return
  try {
    const result = await api('/api/drafts/' + encodeURIComponent(id), 'DELETE')
    showResult('draftsResult', '已删除草稿', 'success')
    loadDrafts()
    loadDraftLogs()
    peekDraftUndo()
  } catch (e) {
    showResult('draftsResult', '删除失败: ' + e.message, 'error')
  }
}

async function duplicateDraft(id) {
  const newName = prompt('输入新草稿名称：')
  if (newName === null) return
  const trimmedName = newName.trim()
  if (!trimmedName) {
    alert('请输入草稿名称')
    return
  }
  try {
    const result = await api('/api/drafts/' + encodeURIComponent(id) + '/duplicate', 'POST', { newName: trimmedName })
    showResult('draftsResult', '已复制草稿: ' + result.draft.name, 'success')
    loadDrafts()
    loadDraftLogs()
    peekDraftUndo()
  } catch (e) {
    showResult('draftsResult', '复制失败: ' + e.message, 'error')
  }
}

async function applyDraft(id) {
  if (!confirm('确定应用此草稿？当前工作区的提交将被替换。')) return
  try {
    const result = await api('/api/drafts/' + encodeURIComponent(id) + '/apply', 'POST')
    showResult('draftsResult', `已应用草稿: ${result.draft.name} (${result.appliedCommitCount} 条提交)`, 'success')
    loadCommits()
  } catch (e) {
    showResult('draftsResult', '应用失败: ' + e.message, 'error')
  }
}

async function archiveFromDraft(id) {
  if (!confirm('确定从此草稿归档？归档后草稿将被删除，提交将移动到归档中。')) return
  try {
    const result = await api('/api/drafts/' + encodeURIComponent(id) + '/archive', 'POST')
    showResult('draftsResult', `已归档: ${result.draft.version} (${result.snapshot.commitCount} 条提交)`, 'success')
    loadDrafts()
    loadDraftLogs()
    peekDraftUndo()
    loadArchives()
    loadExportVersions()
  } catch (e) {
    showResult('draftsResult', '归档失败: ' + e.message, 'error')
  }
}

async function viewDraft(id) {
  try {
    const result = await api('/api/drafts/' + encodeURIComponent(id), 'GET')
    const draft = result.draft
    const modal = document.getElementById('viewDraftModal')
    document.getElementById('viewDraftTitle').textContent = `草稿: ${draft.name}`
    
    const groups = { breaking: [], feature: [], fix: [], other: [], ignored: [] }
    draft.commits.forEach(c => {
      const cat = c.category || 'other'
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(c)
    })
    
    let html = `<p>版本号: ${escHtml(draft.version || '(未设置)')} | 提交数: ${draft.commits.length} | 更新时间: ${escHtml(draft.updatedAt)}</p>`
    if (draft.description) {
      html += `<p>描述: ${escHtml(draft.description)}</p>`
    }
    
    const labels = { breaking: '破坏性变更', feature: '新功能', fix: '修复', other: '其他', ignored: '已忽略' }
    Object.keys(labels).forEach(cat => {
      if (groups[cat] && groups[cat].length > 0) {
        html += `<h4>${labels[cat]} (${groups[cat].length})</h4><ul>`
        groups[cat].forEach(c => {
          html += `<li>${escHtml(c.message)}${c.ticket ? ' [' + escHtml(c.ticket) + ']' : ''}${c.note ? ' — <em>' + escHtml(c.note) + '</em>' : ''} <small>(${shortId(c.id)}, 来源: ${c.source})</small></li>`
        })
        html += `</ul>`
      }
    })
    
    document.getElementById('viewDraftBody').innerHTML = html
    modal.classList.remove('hidden')
  } catch (e) {
    alert('查看失败: ' + e.message)
  }
}

function closeViewDraftModal() {
  document.getElementById('viewDraftModal').classList.add('hidden')
}

async function exportDraftJson(id) {
  try {
    const result = await api('/api/drafts/' + encodeURIComponent(id) + '/export', 'POST')
    const jsonStr = JSON.stringify(result.data, null, 2)
    const blob = new Blob([jsonStr], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'draft-' + (result.data.draft ? (result.data.draft.name || 'export') : 'export') + '.json'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    showResult('draftsResult', '草稿已导出为 JSON 文件', 'success')
  } catch (e) {
    showResult('draftsResult', '导出失败: ' + e.message, 'error')
  }
}

function openImportDraftModal() {
  document.getElementById('importDraftModal').classList.remove('hidden')
  document.getElementById('importDraftJson').value = ''
  document.getElementById('importDraftAsName').value = ''
  document.getElementById('importDraftForce').checked = false
  document.getElementById('importDraftResult').classList.add('hidden')
  const fileInput = document.getElementById('importDraftFile')
  if (fileInput) fileInput.value = ''
}

function closeImportDraftModal() {
  document.getElementById('importDraftModal').classList.add('hidden')
}

async function getImportDraftData() {
  const fileInput = document.getElementById('importDraftFile')
  const jsonText = document.getElementById('importDraftJson').value.trim()

  if (fileInput.files && fileInput.files.length > 0) {
    const text = await readFileAsText(fileInput.files[0])
    return JSON.parse(text)
  } else if (jsonText) {
    return JSON.parse(jsonText)
  }
  return null
}

async function doValidateDraftImport() {
  try {
    const data = await getImportDraftData()
    if (!data) {
      showResult('importDraftResult', '请选择文件或粘贴 JSON 内容', 'error')
      return
    }
    if (!data.type || data.type !== 'release-notes-draft') {
      showResult('importDraftResult', '校验失败: 不是有效的草稿文件', 'error')
      return
    }
    showResult('importDraftResult', '校验通过', 'success')
  } catch (e) {
    showResult('importDraftResult', '校验失败: ' + e.message, 'error')
  }
}

async function doImportDraft() {
  try {
    const data = await getImportDraftData()
    if (!data) {
      showResult('importDraftResult', '请选择文件或粘贴 JSON 内容', 'error')
      return
    }
    const asName = document.getElementById('importDraftAsName').value.trim()
    const force = document.getElementById('importDraftForce').checked
    const body = { draftData: data, force }
    if (asName) body.asName = asName

    const result = await api('/api/drafts/import', 'POST', body)
    showResult('importDraftResult', '导入成功: ' + result.draft.name, 'success')
    setTimeout(() => {
      closeImportDraftModal()
      loadDrafts()
      loadDraftLogs()
      peekDraftUndo()
    }, 600)
  } catch (e) {
    if (e.message && (e.message.includes('同名') || e.message.includes('同版本'))) {
      const msg = e.message + '\n\n是否强制覆盖？'
      if (confirm(msg)) {
        try {
          const data = await getImportDraftData()
          const asName = document.getElementById('importDraftAsName').value.trim()
          const body = { draftData: data, force: true }
          if (asName) body.asName = asName
          const result = await api('/api/drafts/import', 'POST', body)
          showResult('importDraftResult', '已覆盖: ' + result.draft.name, 'success')
          setTimeout(() => {
            closeImportDraftModal()
            loadDrafts()
            loadDraftLogs()
            peekDraftUndo()
          }, 600)
        } catch (e2) {
          showResult('importDraftResult', '导入失败: ' + e2.message, 'error')
        }
      }
    } else {
      showResult('importDraftResult', '导入失败: ' + e.message, 'error')
    }
  }
}

async function quickSaveDraft() {
  const name = document.getElementById('quickDraftName').value.trim()
  const version = document.getElementById('quickDraftVersion').value.trim()
  const desc = document.getElementById('quickDraftDesc').value.trim()

  if (!name) {
    showResult('draftsResult', '请输入草稿名称', 'error')
    return
  }

  try {
    const result = await api('/api/drafts', 'POST', { name, version, description: desc })
    showResult('draftsResult', `已保存草稿: ${result.draft.name} (${result.draft.commitCount} 条提交)`, 'success')
    document.getElementById('quickDraftName').value = ''
    document.getElementById('quickDraftVersion').value = ''
    document.getElementById('quickDraftDesc').value = ''
    loadDrafts()
    loadDraftLogs()
    peekDraftUndo()
  } catch (e) {
    if (e.message && (e.message.includes('同名') || e.message.includes('同版本'))) {
      const msg = e.message + '\n\n是否强制覆盖？'
      if (confirm(msg)) {
        try {
          const result = await api('/api/drafts', 'POST', { name, version, description: desc, force: true })
          showResult('draftsResult', `已覆盖草稿: ${result.draft.name} (${result.draft.commitCount} 条提交)`, 'success')
          document.getElementById('quickDraftName').value = ''
          document.getElementById('quickDraftVersion').value = ''
          document.getElementById('quickDraftDesc').value = ''
          loadDrafts()
          loadDraftLogs()
          peekDraftUndo()
        } catch (e2) {
          showResult('draftsResult', '保存失败: ' + e2.message, 'error')
        }
      }
    } else {
      showResult('draftsResult', '保存失败: ' + e.message, 'error')
    }
  }
}

async function loadDraftLogs() {
  try {
    const result = await api('/api/drafts/logs?limit=20', 'GET')
    const logs = result.logs || []
    const el = document.getElementById('draftLogsList')
    if (logs.length === 0) {
      el.innerHTML = '<p style="color:#999">暂无操作日志</p>'
      return
    }
    const actionLabels = { create: '创建', update: '更新', delete: '删除', duplicate: '复制', apply: '应用', archive: '归档', undo: '撤销', import: '导入', export: '导出' }
    el.innerHTML = logs.map(l => {
      const lbl = actionLabels[l.action] || l.action
      return `
        <div class="log-item">
          <span class="log-action">[${lbl}]</span>
          <span class="log-name">${escHtml(l.draftName || l.description || '')}</span>
          <span class="log-time">${escHtml(l.timestamp || '')}</span>
        </div>
      `
    }).join('')
  } catch (e) {
    document.getElementById('draftLogsList').innerHTML = '<p style="color:#e74c3c">加载失败</p>'
  }
}

async function peekDraftUndo() {
  try {
    const snap = await api('/api/drafts/undo/peek', 'GET')
    const el = document.getElementById('draftUndoInfo')
    if (!snap || !snap.description) {
      el.textContent = '没有可撤销的草稿操作'
      el.style.color = '#999'
    } else {
      el.textContent = '可撤销: ' + snap.description + ' (' + snap.timestamp + ')'
      el.style.color = '#333'
    }
  } catch {
    document.getElementById('draftUndoInfo').textContent = '加载失败'
  }
}

async function undoDraftChange() {
  if (!confirm('确定撤销最近一次草稿操作？')) return
  try {
    const result = await api('/api/drafts/undo', 'POST')
    let msg = '已撤销'
    if (result.description) msg += ': ' + result.description
    showResult('draftsResult', msg, 'success')
    loadDrafts()
    loadDraftLogs()
    peekDraftUndo()
  } catch (e) {
    showResult('draftsResult', '撤销失败: ' + e.message, 'error')
  }
}

loadCommits()
