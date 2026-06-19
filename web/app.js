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

async function restoreFromBackup(filename) {
  if (!confirm('确定从此备份恢复配置？当前配置将被覆盖。')) return
  try {
    const force = document.getElementById('cfgRestoreForce').checked
    const dryRun = document.getElementById('cfgRestoreDryRun').checked
    const result = await api('/api/config/restore', 'POST', { filename, force, dryRun })
    displayRestoreResult(result)
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

async function importConfigBackup() {
  try {
    const backupData = await getRestoreInput()
    if (!backupData) {
      showResult('restoreResult', '请选择文件或粘贴 JSON 内容', 'error')
      return
    }
    if (!confirm('确定从此备份恢复配置？当前配置将被覆盖。')) return
    const force = document.getElementById('cfgRestoreForce').checked
    const dryRun = document.getElementById('cfgRestoreDryRun').checked
    const result = await api('/api/config/restore', 'POST', { backupData, force, dryRun })
    displayRestoreResult(result)
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
      msg += '\n✓ 配置恢复成功'
      if (result.changes && result.changes.length > 0) {
        msg += '\n\n已应用 ' + result.changes.length + ' 处变更'
      }
      showResult('restoreResult', msg, 'success')
      loadConfig()
      peekRestoreUndo()
    }
  } else {
    showResult('restoreResult', msg || '恢复失败', 'error')
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
    } else {
      showResult('configResult', msg || result.reason || '撤销失败', 'error')
    }
  } catch (e) {
    showResult('configResult', '撤销失败: ' + e.message, 'error')
  }
}

loadCommits()
