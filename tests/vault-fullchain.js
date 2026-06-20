const fs = require('fs')
const path = require('path')

const DATA_DIR = path.resolve(__dirname, '..', 'data')

function cleanData() {
  if (!fs.existsSync(DATA_DIR)) return
  const files = fs.readdirSync(DATA_DIR)
  files.forEach(f => {
    if (f.endsWith('.json')) {
      fs.unlinkSync(path.join(DATA_DIR, f))
    }
  })
}

let passed = 0
let failed = 0
const errors = []

function assert(condition, message) {
  if (condition) {
    passed++
  } else {
    failed++
    errors.push(message)
    console.error(`  ✗ ${message}`)
  }
}

function assertOk(result, label) {
  if (result.success === false) {
    failed++
    const msg = `${label}: ${result.errors ? result.errors.join('; ') : result.reason || 'unknown'}`
    errors.push(msg)
    console.error(`  ✗ ${msg}`)
  } else {
    passed++
  }
}

function section(title) {
  console.log(`\n\x1b[36m=== ${title} ===\x1b[0m`)
}

function cleanVaultData() {
  const vaultFiles = ['draft_vault', 'draft_vault_logs', 'draft_vault_recovery_undo']
  vaultFiles.forEach(name => {
    const fp = path.join(DATA_DIR, `${name}.json`)
    if (fs.existsSync(fp)) fs.unlinkSync(fp)
  })
}

function run() {
  console.log('\x1b[36m草稿恢复保险箱端到端验证测试\x1b[0m')
  console.log('='.repeat(50))

  cleanData()

  const store = require('../src/store')
  const draft = require('../src/draft')
  const draftVault = require('../src/draftVault')
  const versionRegistry = require('../src/versionRegistry')
  const archiver = require('../src/archiver')
  const exporter = require('../src/exporter')
  const classifier = require('../src/classifier')
  const reviewer = require('../src/reviewer')

  section('1. 创建草稿 + 保险箱快照生成')

  const commits = [
    { id: 'c1', hash: 'aaa111', message: 'feat: 新增用户管理', author: '张三', date: '2025-01-01', ticket: 'PROJ-101', version: 'v1.0.0', category: 'feature', note: '', source: 'git', reviewed: true, resolved: false, issues: [] },
    { id: 'c2', hash: 'bbb222', message: 'fix: 修复登录超时', author: '李四', date: '2025-01-02', ticket: 'PROJ-102', version: 'v1.0.0', category: 'fix', note: '', source: 'git', reviewed: true, resolved: false, issues: [] },
    { id: 'c3', hash: 'ccc333', message: 'feat: 新增导出功能', author: '王五', date: '2025-01-03', ticket: 'PROJ-103', version: 'v1.0.0', category: 'feature', note: '', source: 'git', reviewed: true, resolved: false, issues: [] }
  ]
  store.saveCommits(commits)

  const createResult = draft.createDraft({
    name: 'v1.0.0 发布说明',
    version: 'v1.0.0',
    description: '第一个正式版本',
    userId: 'testuser',
    userName: '测试用户'
  })
  assertOk(createResult, '创建草稿')
  assert(createResult.draft !== undefined, '创建草稿返回了 draft 对象')
  assert(createResult.draft.commits.length === 3, `草稿正文提交数: ${createResult.draft.commits.length} === 3`)

  const vaultStatus1 = draftVault.getStatus()
  assert(vaultStatus1.totalSnapshots >= 1, `保险箱有快照: ${vaultStatus1.totalSnapshots} >= 1`)
  assert(vaultStatus1.byStatus.committed >= 1, `有已提交快照: ${vaultStatus1.byStatus.committed} >= 1`)

  const snapshots = draftVault.listSnapshots({ action: 'create' })
  assert(snapshots.length >= 1, `创建操作快照数: ${snapshots.length} >= 1`)
  const createSnap = snapshots[0]
  assert(createSnap.body.length === 3, `快照正文提交数: ${createSnap.body.length} === 3`)
  assert(createSnap.summary === '第一个正式版本', '快照摘要正确')
  assert(createSnap.version === 'v1.0.0', '快照版本正确')
  assert(createSnap.source === 'cli', '快照来源正确 (cli)')
  assert(createSnap.operator === 'testuser', '快照操作者正确')

  section('2. 修复版本 + 版本变更快照')

  const draftId = createResult.draft.id
  const updateResult = draft.updateDraft(draftId, { version: 'v1.1.0' }, { userId: 'testuser', userName: '测试用户' })
  assertOk(updateResult, '更新草稿版本')
  assert(updateResult.draft.version === 'v1.1.0', `更新后版本: ${updateResult.draft.version} === v1.1.0`)

  const versionSnaps = draftVault.listSnapshots({ action: 'update', draftId })
  assert(versionSnaps.length >= 1, `版本更新快照数: ${versionSnaps.length} >= 1`)

  const currentDraft = draft.getDraft(draftId)
  assert(currentDraft.version === 'v1.1.0', `草稿当前版本: ${currentDraft.version} === v1.1.0`)
  assert(currentDraft.commits.length === 3, `正文未被摘要覆盖: 提交数=${currentDraft.commits.length}`)

  section('3. 异常中断模拟 (pending 事务)')

  cleanVaultData()

  const manualSnap = draftVault.createSnapshot(draftId, draftVault.ACTION_UPDATE, draftVault.SOURCE_CLI, {
    operator: 'testuser',
    operatorName: '测试用户',
    draftName: 'v1.0.0 发布说明',
    version: 'v1.2.0'
  })
  assertOk(manualSnap, '手动创建 pending 快照')
  assert(manualSnap.snapshot.status === 'pending', `快照状态: ${manualSnap.snapshot.status} === pending`)

  const pendingBefore = draftVault.findPendingTxns()
  assert(pendingBefore.length >= 1, `有未完成事务: ${pendingBefore.length} >= 1`)

  section('4. 重启后自动发现 + 恢复')

  const pending = draftVault.findPendingTxns()
  assert(pending.length >= 1, `自动发现未完成事务: ${pending.length} >= 1`)

  const recoverResult = draftVault.recoverPendingTxns()
  assertOk(recoverResult, '自动恢复未完成事务')
  assert(recoverResult.recovered >= 1, `恢复了 ${recoverResult.recovered} 条事务`)

  const pendingAfter = draftVault.findPendingTxns()
  assert(pendingAfter.length === 0, `恢复后无未完成事务: ${pendingAfter.length} === 0`)

  section('5. 继续编辑 + 正文优先还原验证')

  const editResult = draft.updateDraft(draftId, { description: '更新后的描述' }, { userId: 'testuser', userName: '测试用户' })
  assertOk(editResult, '继续编辑草稿')

  const d = draft.getDraft(draftId)
  assert(d.description === '更新后的描述', `描述已更新: ${d.description}`)
  assert(d.commits.length === 3, `正文完整: 提交数=${d.commits.length}`)

  const editSnaps = draftVault.listSnapshots({ action: 'update', draftId })
  if (editSnaps.length > 0) {
    const snap = editSnaps[0]
    assert(snap.body.length === 3, '快照正文完整 (3 条提交)')
    assert(typeof snap.summary === 'string', '快照摘要独立记录')
    assert(snap.draftSnapshot.commits.length === snap.body.length, '正文与草稿快照正文一致')
  }

  section('6. 摘要不倒灌回草稿正文验证')

  const descOnlyDraft = draft.createDraft({
    name: '摘要测试草稿',
    version: '',
    description: '这是摘要不是正文',
    userId: 'testuser',
    userName: '测试用户'
  })
  assertOk(descOnlyDraft, '创建摘要测试草稿')

  const descDraft = descOnlyDraft.draft
  const descDraftId = descDraft.id

  const descSnaps = draftVault.listSnapshots({ draftId: descDraftId })
  if (descSnaps.length > 0) {
    const snap = descSnaps[0]
    assert(snap.summary === '这是摘要不是正文', '快照摘要字段正确')
    assert(Array.isArray(snap.body), '快照正文是数组')
    const freshDraft = draft.getDraft(descDraftId)
    assert(freshDraft.description === '这是摘要不是正文', '草稿摘要字段未变')
    assert(Array.isArray(freshDraft.commits), '草稿commits仍然是数组')
  }

  section('7. 回滚 + 撤销能力')

  const beforeUpdate = JSON.parse(JSON.stringify(draft.getDraft(draftId)))

  const rollbackSnaps = draftVault.listSnapshots({ draftId, action: 'update' })
  if (rollbackSnaps.length > 0) {
    const snapToRollback = rollbackSnaps[0]
    if (snapToRollback.status === 'committed') {
      const rbResult = draftVault.rollbackSnapshot(snapToRollback.id)
      assertOk(rbResult, '回滚快照')

      const undoPeek = draftVault.peekRecoveryUndo()
      assert(undoPeek !== null, '有可撤销的恢复/回滚操作')

      const undoResult = draftVault.undoLastRecovery()
      assertOk(undoResult, '撤销回滚')
    }
  }

  section('8. 同版本/同名冲突处理')

  const conflictDraft = draft.createDraft({
    name: '冲突测试',
    version: 'v2.0.0',
    userId: 'userA',
    userName: '用户A'
  })
  assertOk(conflictDraft, '创建冲突测试草稿')

  const conflictResult = draft.createDraft({
    name: '冲突测试',
    version: 'v2.0.0',
    userId: 'userB',
    userName: '用户B'
  })
  assert(conflictResult.success === false, '同名+同版本被阻止')
  assert(conflictResult.blocked === true, '操作被标记为 blocked')

  const resolveResult = draft.createDraft({
    name: '冲突测试',
    version: 'v2.0.0',
    userId: 'userB',
    userName: '用户B',
    force: true,
    isAdmin: true,
    takeoverReason: '测试强制接管'
  })
  assertOk(resolveResult, '管理员强制接管解决冲突')

  section('9. JSON 导入导出')

  const exportResult = draftVault.exportVaultToJson()
  assert(exportResult.type === 'draft-vault-export', '导出类型正确')
  assert(Array.isArray(exportResult.snapshots), '导出包含快照数组')
  assert(exportResult.snapshots.length > 0, `导出快照数: ${exportResult.snapshots.length}`)

  const tempFile = path.join(DATA_DIR, 'vault-export-test.json')
  const fileResult = draftVault.exportVaultToFile(tempFile)
  assertOk(fileResult, '导出到文件')

  const importResult = draftVault.importVaultFromFile(tempFile, { force: true })
  assertOk(importResult, '从文件导入')
  assert(importResult.importedCount > 0, `导入了 ${importResult.importedCount} 个快照`)

  try { fs.unlinkSync(tempFile) } catch {}

  section('10. 关键日志验证')

  const logs = draftVault.listLogs(50)
  assert(logs.length > 0, `有日志记录: ${logs.length}`)
  const hasCreateLog = logs.some(l => l.action === 'create_snapshot')
  const hasCommitLog = logs.some(l => l.action === 'commit_snapshot')
  assert(hasCreateLog, '有创建快照日志')
  assert(hasCommitLog, '有提交快照日志')

  section('11. 归档草稿 + Markdown 导出')

  const archiveDraft = draft.createDraft({
    name: '归档测试',
    version: 'v3.0.0',
    userId: 'testuser',
    userName: '测试用户'
  })
  assertOk(archiveDraft, '创建归档测试草稿')

  store.saveCommits(archiveDraft.draft.commits.map(c => ({ ...c, reviewed: true, resolved: true, issues: [] })))
  classifier.classify()
  archiveDraft.draft.commits.forEach(c => reviewer.review(c.id))

  const archiveResult = draft.archiveDraft(archiveDraft.draft.id)
  assertOk(archiveResult, '归档草稿')

  const archiveSnaps = draftVault.listSnapshots({ action: 'archive', draftId: archiveDraft.draft.id })
  assert(archiveSnaps.length >= 1, `归档操作有保险箱快照: ${archiveSnaps.length}`)

  const archives = archiver.listArchives()
  assert(archives.length > 0, `有归档记录: ${archives.length}`)

  const v3 = archives.find(a => a.version === 'v3.0.0')
  if (v3) {
    try {
      const md = exporter.generateMarkdown('v3.0.0')
      assert(md.includes('v3.0.0'), 'Markdown 包含版本号')
      assert(md.length > 50, `Markdown 内容长度: ${md.length} > 50`)
      console.log(`  ✓ Markdown 导出成功 (${md.length} 字符)`)
    } catch (e) {
      failed++
      errors.push(`Markdown 导出失败: ${e.message}`)
    }
  }

  section('12. 快照归档 + 清理')

  const allSnaps = draftVault.listSnapshots({})
  const committedSnaps = allSnaps.filter(s => s.status === 'committed')
  if (committedSnaps.length > 0) {
    const archiveResult = draftVault.archiveSnapshot(committedSnaps[0].id)
    assertOk(archiveResult, '归档快照')

    const cleanResult = draftVault.cleanArchivedSnapshots()
    assertOk(cleanResult, '清理已归档快照')
  }

  console.log('\n' + '='.repeat(50))
  console.log(`\x1b[32m通过: ${passed}\x1b[0m \x1b[31m失败: ${failed}\x1b[0m`)
  if (errors.length > 0) {
    console.log('\n\x1b[31m失败项:\x1b[0m')
    errors.forEach(e => console.log(`  ✗ ${e}`))
  }
  console.log()

  if (failed > 0) {
    process.exit(1)
  }
}

run()
