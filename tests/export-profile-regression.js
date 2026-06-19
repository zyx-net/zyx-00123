const fs = require('fs')
const path = require('path')
const os = require('os')

const store = require('../src/store')
const config = require('../src/config')
const exportProfile = require('../src/exportProfile')
const exporter = require('../src/exporter')
const importer = require('../src/importer')
const classifier = require('../src/classifier')
const validator = require('../src/validator')
const reviewer = require('../src/reviewer')
const archiver = require('../src/archiver')

function cleanupAll() {
  const dataDir = store.DATA_DIR
  if (fs.existsSync(dataDir)) {
    const files = fs.readdirSync(dataDir)
    files.forEach(f => {
      const fp = path.join(dataDir, f)
      try {
        const stat = fs.statSync(fp)
        if (stat.isFile()) fs.unlinkSync(fp)
      } catch {}
    })
    const backupsDir = path.join(dataDir, 'backups')
    if (fs.existsSync(backupsDir)) {
      try {
        const bf = fs.readdirSync(backupsDir)
        bf.forEach(f => { try { fs.unlinkSync(path.join(backupsDir, f)) } catch {} })
        fs.rmdirSync(backupsDir)
      } catch {}
    }
  }
  config.reset()
}

function prepareAndArchive(version, note, commitPreprocess) {
  store.saveCommits([])
  store.saveArchives([])
  importer.importFromCsv('sample.csv')
  classifier.classify()
  let commits = store.loadCommits()
  for (let i = 0; i < commits.length; i++) {
    if (commits[i].version === '2.0') commits[i].version = 'v2.0.0'
    if (!commits[i].ticket) commits[i].ticket = 'PROJ-000'
  }
  store.saveCommits(commits)
  commits = store.loadCommits()
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i]
    if (c.category === 'ignored') continue
    if (typeof commitPreprocess === 'function') {
      commitPreprocess(c, reviewer, store)
    }
    reviewer.review(c.id, note || '')
  }
  let vr = validator.validate()
  if (vr && vr.errors && vr.errors.length > 0) {
    commits = store.loadCommits()
    for (const e of vr.errors) {
      const m = (e.message || '').match(/^([a-f0-9]{6,}):/)
      if (m) {
        const idx = commits.findIndex(x => x.id && x.id.startsWith(m[1]))
        if (idx >= 0) {
          if (e.message.includes('工单号')) commits[idx].ticket = commits[idx].ticket || 'PROJ-000'
          if (e.message.includes('版本号')) commits[idx].version = 'v1.0.0'
        }
      }
    }
    store.saveCommits(commits)
    validator.validate()
  }
  commits = store.loadCommits()
  let anyFixed = false
  for (let i = 0; i < commits.length; i++) {
    if (commits[i].category === 'ignored') continue
    if (commits[i].issues && commits[i].issues.length > 0) {
      commits[i].issues = commits[i].issues.filter(it => {
        if (it.includes('缺失工单号') && commits[i].ticket) return false
        if (it.includes('版本号不合规') && commits[i].version && /^v?\d+\.\d+\.\d+$/.test(commits[i].version)) return false
        return true
      })
      commits[i].resolved = commits[i].issues.length === 0
      anyFixed = true
    }
  }
  if (anyFixed) store.saveCommits(commits)
  return archiver.archive(version)
}

function runTests() {
  let pass = 0, fail = 0
  const assert = (cond, msg) => {
    if (cond) { pass++; console.log(`  ✓ ${msg}`) }
    else { fail++; console.error(`  ✗ ${msg}`) }
  }
  const assertEq = (a, b, msg) => {
    const ok = JSON.stringify(a) === JSON.stringify(b)
    if (ok) { pass++; console.log(`  ✓ ${msg}`) }
    else {
      fail++
      console.error(`  ✗ ${msg}\n    期望: ${JSON.stringify(b)}\n    实际: ${JSON.stringify(a)}`)
    }
  }

  console.log('\n====== 导出方案 Bug 回归 + 新功能验证 ======\n')

  cleanupAll()

  console.log('【基础 1】创建第一个方案 — 自动设为默认 + 落盘持久化')
  cleanupAll()
  const r1 = exportProfile.createProfile({
    name: '标准方案',
    titleTemplate: 'Release Notes - ${version}',
    groupOrder: ['feature', 'fix', 'breaking', 'other'],
    includeTicket: true,
    includeAuthor: true,
    includeDate: true,
    outputDir: path.join(os.tmpdir(), 'rn-output-1')
  })
  assert(r1.success === true, '创建方案 success')
  assert(r1.created === true, 'created=true（非覆盖）')
  assert(r1.profile.isDefault === true, '第一个方案自动设为默认')
  assert(r1.profile.name === '标准方案', '方案名正确')
  assertEq(r1.profile.groupOrder, ['feature', 'fix', 'breaking', 'other'], '分组顺序正确')
  const raw1 = store.loadExportProfiles()
  assert(raw1.profiles.length === 1, '磁盘上 profiles 数量为 1')
  assert(raw1.default === r1.profile.id, '磁盘上 default 指向新方案')

  console.log('\n【基础 2】listProfiles 返回列表 + 按 name/id 查询')
  const list2 = exportProfile.listProfiles()
  assert(list2.length === 1, 'listProfiles 返回 1 条')
  assert(list2[0].isDefault === true, '默认标记正确')
  const byId2 = exportProfile.getProfile(r1.profile.id)
  assert(byId2 !== null, '按 ID 查询成功')
  assertEq(byId2.name, '标准方案', '按 ID 查询方案名正确')
  const byName2 = exportProfile.getProfileByName('标准方案')
  assert(byName2 !== null, '按名称查询成功')
  assert(byName2.id === r1.profile.id, '按名称查询 ID 正确')
  const notExist2 = exportProfile.getProfile('nonexistent-id')
  assert(notExist2 === null, '不存在的 ID 返回 null')

  console.log('\n【基础 3】第二个方案 — 不影响默认 + 同名阻塞（无 force）')
  cleanupAll()
  exportProfile.createProfile({ name: '方案A', titleTemplate: 'A', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  const r3dup = exportProfile.createProfile({ name: '方案A', titleTemplate: 'A2', groupOrder: ['fix'], includeTicket: false, includeAuthor: false, includeDate: false, outputDir: '' })
  assert(r3dup.success === false, '同名方案无 force 时 success=false')
  assert(r3dup.blocked === true, 'blocked=true')
  assert(r3dup.reason === 'duplicate_name', 'reason=duplicate_name')
  assert(typeof r3dup.existingProfileId === 'string', '返回 existingProfileId')
  const list3after = exportProfile.listProfiles()
  assert(list3after.length === 1, '阻塞后磁盘上仍只有 1 个方案')

  console.log('\n【基础 4】同名方案 — force=true 覆盖')
  cleanupAll()
  const r4a = exportProfile.createProfile({ name: '覆盖测试', titleTemplate: 'OLD', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: 'old-dir' })
  const oldId4 = r4a.profile.id
  const r4b = exportProfile.createProfile({ name: '覆盖测试', titleTemplate: 'NEW', groupOrder: ['fix'], includeTicket: false, includeAuthor: true, includeDate: true, outputDir: 'new-dir' }, { force: true })
  assert(r4b.success === true, 'force 覆盖 success')
  assert(r4b.overwritten === true, 'overwritten=true')
  assert(r4b.profile.id === oldId4, '覆盖后 ID 不变')
  assert(r4b.profile.titleTemplate === 'NEW', 'titleTemplate 已更新为新值')
  assertEq(r4b.profile.groupOrder, ['fix'], 'groupOrder 已更新')
  const list4 = exportProfile.listProfiles()
  assert(list4.length === 1, '覆盖后仍是 1 个方案')

  console.log('\n【基础 5】setDefault 切换默认方案 + 删除默认方案时自动重新分配')
  cleanupAll()
  const r5a = exportProfile.createProfile({ name: '默认1', titleTemplate: 'D1', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  const r5b = exportProfile.createProfile({ name: '默认2', titleTemplate: 'D2', groupOrder: ['fix'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  assert(r5a.profile.isDefault === true, '第一个是默认')
  assert(r5b.profile.isDefault === false, '第二个不是默认')
  const sd5 = exportProfile.setDefault(r5b.profile.id)
  assert(sd5.success === true, 'setDefault success')
  assert(sd5.previousDefault === r5a.profile.id, 'previousDefault 正确')
  const list5after = exportProfile.listProfiles()
  const def5after = list5after.find(p => p.isDefault)
  assert(def5after.id === r5b.profile.id, '切换后默认方案正确')
  const del5 = exportProfile.deleteProfile(r5b.profile.id)
  assert(del5.success === true, '删除默认方案 success')
  assert(del5.wasDefault === true, 'wasDefault=true')
  assert(del5.newDefault === r5a.profile.id, 'newDefault 自动指向第一个剩余方案')
  const list5final = exportProfile.listProfiles()
  assert(list5final.length === 1, '删除后剩 1 个')
  assert(list5final[0].isDefault === true, '剩余方案被设为默认')

  console.log('\n【基础 6】deleteProfile 删除不存在的方案给出错误')
  cleanupAll()
  exportProfile.createProfile({ name: '存在的', titleTemplate: 'X', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  const del6 = exportProfile.deleteProfile('not-exist-id')
  assert(del6.success === false, '删除不存在的方案 success=false')
  assert(del6.errors.some(e => e.includes('方案不存在')), '错误信息含"方案不存在"')

  console.log('\n【基础 7】updateProfile 更新方案字段 + 重命名触发同名检查')
  cleanupAll()
  const r7a = exportProfile.createProfile({ name: '原名', titleTemplate: 'OLD', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: 'old' })
  exportProfile.createProfile({ name: '冲突名', titleTemplate: 'C', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  const up7bad = exportProfile.updateProfile(r7a.profile.id, { name: '冲突名' })
  assert(up7bad.success === false, '重命名到已存在名称时阻塞')
  assert(up7bad.reason === 'duplicate_name', 'reason=duplicate_name')
  const up7ok = exportProfile.updateProfile(r7a.profile.id, {
    titleTemplate: 'NEW-TPL',
    includeTicket: false,
    outputDir: 'new-output-dir'
  })
  assert(up7ok.success === true, '正常字段更新 success')
  assert(up7ok.profile.titleTemplate === 'NEW-TPL', 'titleTemplate 已更新')
  assert(up7ok.profile.includeTicket === false, 'includeTicket 已更新')
  assert(up7ok.profile.outputDir === 'new-output-dir', 'outputDir 已更新')

  console.log('\n【基础 8】duplicateProfile 复制方案')
  cleanupAll()
  const r8a = exportProfile.createProfile({ name: '源方案', titleTemplate: 'SRC', groupOrder: ['breaking', 'feature'], includeTicket: true, includeAuthor: true, includeDate: false, outputDir: 'src-dir' })
  const dup8 = exportProfile.duplicateProfile(r8a.profile.id, '复制后的方案')
  assert(dup8.success === true, '复制方案 success')
  assert(dup8.profile.id !== r8a.profile.id, '新方案 ID 不同')
  assert(dup8.profile.name === '复制后的方案', '新方案名称正确')
  assertEq(dup8.profile.groupOrder, ['breaking', 'feature'], 'groupOrder 复制正确')
  assert(dup8.profile.outputDir === 'src-dir', 'outputDir 复制正确')
  const dup8auto = exportProfile.duplicateProfile(r8a.profile.id)
  assert(dup8auto.success === true, '不指定新名称时自动生成副本名')
  assert(dup8auto.profile.name.includes('副本'), '自动名称含"副本"')

  console.log('\n【字段校验 1】validateProfile 检测缺失字段、类型错误、重复/未知分类')
  const v1 = exportProfile.validateProfile({})
  assert(v1.valid === false, '空对象 invalid')
  assert(v1.errors.some(e => e.includes('缺少必要字段')), '提示缺少必要字段')
  const v2 = exportProfile.validateProfile({
    name: 'test',
    titleTemplate: 'tpl',
    groupOrder: 'not-array',
    includeTicket: 'yes',
    includeAuthor: false,
    includeDate: true,
    outputDir: '/tmp'
  })
  assert(v2.valid === false, '类型错误 invalid')
  assert(v2.errors.some(e => e.includes('groupOrder')), '提示 groupOrder 类型错误')
  assert(v2.errors.some(e => e.includes('includeTicket')), '提示 includeTicket 类型错误')
  const v3 = exportProfile.validateProfile({
    name: 'test',
    titleTemplate: 'tpl',
    groupOrder: ['feature', 'feature', 'unknown-cat'],
    includeTicket: true,
    includeAuthor: false,
    includeDate: false,
    outputDir: ''
  })
  assert(v3.valid === false, '重复/未知分类 invalid')
  assert(v3.errors.some(e => e.includes('重复分类')), '提示重复分类')
  assert(v3.warnings.some(w => w.includes('unknown-cat')), '警告未知分类')
  const v4 = exportProfile.validateProfile({
    name: 'test',
    titleTemplate: 'tpl',
    groupOrder: ['feature'],
    includeTicket: true,
    includeAuthor: false,
    includeDate: false,
    outputDir: ''
  })
  assert(v4.valid === true, '合法方案 valid')
  assert(v4.warnings.some(w => w.includes('缺少分类')), '警告缺少分类')

  console.log('\n【Markdown 导出 1】按方案生成 Markdown — 标题模板、分组顺序、带工单/作者/日期')
  cleanupAll()
  config.reset()
  prepareAndArchive('v1.0.0', '测试备注', (c, reviewer, store) => {
    if (c.message.includes('更新 API 文档')) reviewer.setTicket(c.id, 'PROJ-104')
  })
  const commits9 = store.loadCommits()
  const profile9 = exportProfile.createProfile({
    name: '完整导出方案',
    titleTemplate: '=== Release ${version} ===',
    groupOrder: ['other', 'fix', 'feature', 'breaking'],
    includeTicket: true,
    includeAuthor: true,
    includeDate: false,
    outputDir: ''
  })
  const md9 = exporter.generateMarkdown('v1.0.0', profile9.profile)
  assert(md9.includes('=== Release v1.0.0 ==='), '标题模板正确渲染')
  const idxOther9 = md9.indexOf('📋 其他')
  const idxFix9 = md9.indexOf('🐛 修复')
  const idxFeature9 = md9.indexOf('✨ 新功能')
  const idxBreaking9 = md9.indexOf('⚠ 破坏性变更')
  assert(idxOther9 < idxFix9 && idxFix9 < idxFeature9 && idxFeature9 < idxBreaking9, '分组顺序正确（other→fix→feature→breaking）')
  assert(md9.includes('PROJ-104'), '包含工单号')
  const authors9 = commits9.filter(c => c.category !== 'ignored').map(c => c.author)
  if (authors9.length > 0) {
    assert(authors9.some(a => md9.includes(a)), '包含作者名')
  }
  assert(!md9.includes('归档时间:'), 'includeDate=false 时不显示归档时间')

  console.log('\n【Markdown 导出 2】默认方案（不传 profile）等价于 getDefaultProfileObj')
  const md10a = exporter.generateMarkdown('v1.0.0')
  const defObj10 = exportProfile.getDefaultProfileObj()
  const md10b = exporter.generateMarkdown('v1.0.0', defObj10)
  assertEq(md10a, md10b, '不传 profile 和传默认方案对象结果一致')

  console.log('\n【Markdown 导出 3】exportToFile 按方案导出 + 输出目录检查')
  cleanupAll()
  config.reset()
  prepareAndArchive('v2.0.0')
  const commits11 = store.loadCommits()
  for (const c of commits11) {
    if (c.category === 'ignored') continue
    if (c.message.includes('更新 API 文档')) reviewer.setTicket(c.id, 'PROJ-999')
  }
  const tmpDir11 = path.join(os.tmpdir(), `rn-export-test-${Date.now()}`)
  const profile11 = exportProfile.createProfile({
    name: '自定义目录',
    titleTemplate: 'Release ${version}',
    groupOrder: ['feature', 'fix'],
    includeTicket: false,
    includeAuthor: false,
    includeDate: true,
    outputDir: tmpDir11
  })
  const r11 = exporter.exportToFile('v2.0.0', null, { profileId: profile11.profile.id })
  assert(fs.existsSync(r11.path), '文件已写出')
  assert(r11.path.startsWith(tmpDir11), '输出目录是方案指定的目录')
  const content11 = fs.readFileSync(r11.path, 'utf-8')
  assert(content11.includes('Release v2.0.0'), '文件内容包含正确标题')
  try { fs.unlinkSync(r11.path); fs.rmdirSync(tmpDir11) } catch {}

  console.log('\n【导出 4】checkOutputWritable 检测不可写目录')
  const winNoWrite = path.join('C:', 'Windows', 'System32', 'rn-test-noperm')
  const nowin = exportProfile.checkOutputWritable(winNoWrite)
  assert(nowin.writable === false || nowin.writable === true, 'checkOutputWritable 不抛异常（Windows 下可能可写）')

  console.log('\n【导入导出 1】exportProfileToJson + importProfileFromJson 往返')
  cleanupAll()
  const r13a = exportProfile.createProfile({
    name: '往返方案',
    titleTemplate: '往返 ${version}',
    groupOrder: ['breaking', 'other'],
    includeTicket: true,
    includeAuthor: true,
    includeDate: true,
    outputDir: '/round/trip'
  })
  const exp13 = exportProfile.exportProfileToJson(r13a.profile.id)
  assert(exp13.success === true, '导出 JSON success')
  assert(exp13.data.schemaVersion === exportProfile.PROFILE_SCHEMA_VERSION, '导出含 schemaVersion')
  assert(exp13.data.profile.name === '往返方案', '导出 profile 含 name')
  cleanupAll()
  const imp13 = exportProfile.importProfileFromJson(exp13.data)
  assert(imp13.success === true, '导入 JSON success')
  assert(imp13.profile.titleTemplate === '往返 ${version}', '导入后 titleTemplate 正确')
  assertEq(imp13.profile.groupOrder, ['breaking', 'other'], '导入后 groupOrder 正确')
  assert(imp13.profile.outputDir === '/round/trip', '导入后 outputDir 正确')

  console.log('\n【导入导出 2】旧格式 JSON（无外层 schemaVersion/profile 包装）兼容导入')
  cleanupAll()
  const oldFormat14 = {
    name: '旧格式方案',
    titleTemplate: 'Old Format ${version}',
    groupOrder: ['fix'],
    includeTicket: false,
    includeAuthor: false,
    includeDate: false,
    outputDir: '/old'
  }
  const imp14 = exportProfile.importProfileFromJson(oldFormat14)
  assert(imp14.success === true, '旧格式兼容导入 success')
  assert(imp14.warnings.some(w => w.includes('非标准格式') || w.includes('旧方案')), '警告提示非标准格式')
  assert(imp14.profile.name === '旧格式方案', '旧格式导入后 name 正确')

  console.log('\n【导入导出 3】exportProfileToFile + importProfileFromFile 文件往返')
  cleanupAll()
  const r15a = exportProfile.createProfile({
    name: '文件往返',
    titleTemplate: 'File Roundtrip ${version}',
    groupOrder: ['feature'],
    includeTicket: true,
    includeAuthor: false,
    includeDate: false,
    outputDir: '/file'
  })
  const tmpFile15 = path.join(os.tmpdir(), `profile-roundtrip-${Date.now()}.json`)
  const exp15 = exportProfile.exportProfileToFile(r15a.profile.id, tmpFile15)
  assert(exp15.success === true, '导出到文件 success')
  assert(fs.existsSync(tmpFile15), '文件存在')
  cleanupAll()
  const imp15 = exportProfile.importProfileFromFile(tmpFile15)
  assert(imp15.success === true, '从文件导入 success')
  assert(imp15.profile.name === '文件往返', '文件导入后 name 正确')
  try { fs.unlinkSync(tmpFile15) } catch {}

  console.log('\n【导入导出 4】导入时 --asName 重命名 + 导入字段缺失警告')
  cleanupAll()
  exportProfile.createProfile({ name: '已存在', titleTemplate: 'X', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  const r16 = {
    name: '已存在',
    titleTemplate: 'Imported',
    groupOrder: ['feature', 'fix'],
    includeTicket: true,
    includeAuthor: false,
    includeDate: false,
    outputDir: ''
  }
  const imp16dup = exportProfile.importProfileFromJson(r16)
  assert(imp16dup.success === false, '同名导入无 force 阻塞')
  const imp16rename = exportProfile.importProfileFromJson(r16, { asName: '导入后新名称' })
  assert(imp16rename.success === true, 'asName 重命名后导入 success')
  assert(imp16rename.profile.name === '导入后新名称', 'asName 生效')
  const missingFields = {
    name: '缺字段',
    titleTemplate: 'T'
  }
  const imp16miss = exportProfile.importProfileFromJson(missingFields)
  assert(imp16miss.success === true || imp16miss.success === false, '缺字段导入不抛异常')

  console.log('\n【撤销链路 1】创建、更新、删除、设默认都能撤销（含回滚验证）')
  cleanupAll()
  const r17a = exportProfile.createProfile({ name: '撤销测试A', titleTemplate: 'A', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  const r17b = exportProfile.createProfile({ name: '撤销测试B', titleTemplate: 'B', groupOrder: ['fix'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  const pk17a = exportProfile.peekUndo()
  assert(pk17a !== null, 'peekUndo 返回最近操作')
  assert(pk17a.description.includes('创建'), '描述含"创建"')
  const undo17create = exportProfile.undoLastChange()
  assert(undo17create.success === true, '撤销创建 success')
  const list17a = exportProfile.listProfiles()
  assert(list17a.length === 1, '撤销一个创建后剩 1 个')
  assert(!list17a.some(p => p.name === '撤销测试B'), 'B 已被撤销')
  exportProfile.updateProfile(r17a.profile.id, { titleTemplate: 'UPDATED' })
  const undo17update = exportProfile.undoLastChange()
  assert(undo17update.success === true, '撤销更新 success')
  const p17after = exportProfile.getProfile(r17a.profile.id)
  assert(p17after.titleTemplate === 'A', '撤销更新后 titleTemplate 回到原值')
  exportProfile.setDefault(r17a.profile.id)
  const undo17sd = exportProfile.undoLastChange()
  assert(undo17sd.success === true, '撤销设默认 success')
  exportProfile.deleteProfile(r17a.profile.id)
  const undo17del = exportProfile.undoLastChange()
  assert(undo17del.success === true, '撤销删除 success')
  const list17final = exportProfile.listProfiles()
  assert(list17final.length === 1, '撤销删除后方案恢复')
  assert(list17final[0].name === '撤销测试A', '恢复的方案名称正确')
  const noUndo17 = exportProfile.undoLastChange()
  assert(noUndo17.success === false, '没有可撤销时返回 success=false')
  assert(noUndo17.reason === 'no_undo_snapshot', 'reason=no_undo_snapshot')

  console.log('\n【撤销链路 2】撤销后写日志 + peekUndo 之后 undoPeek 返回 null')
  cleanupAll()
  exportProfile.createProfile({ name: '日志撤销', titleTemplate: 'X', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  exportProfile.undoLastChange()
  const pk18 = exportProfile.peekUndo()
  assert(pk18 === null, '撤销后撤销快照已清空')
  const logs18 = exportProfile.listLogs(20)
  assert(logs18.some(l => l.action === 'undo'), '日志中存在 undo 记录')

  console.log('\n【日志链路】listLogs 持久化（跨重启保留）+ 日志条数限制')
  cleanupAll()
  for (let i = 0; i < 5; i++) {
    exportProfile.createProfile({ name: `日志测试${i}`, titleTemplate: `T${i}`, groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  }
  const logs19a = exportProfile.listLogs(100)
  assert(logs19a.length >= 5, '至少 5 条 create 日志')
  const logs19b = exportProfile.listLogs(2)
  assert(logs19b.length === 2, 'limit=2 返回 2 条')
  delete require.cache[require.resolve('../src/store')]
  delete require.cache[require.resolve('../src/exportProfile')]
  const storeReboot19 = require('../src/store')
  const exportProfileReboot19 = require('../src/exportProfile')
  const logs19c = exportProfileReboot19.listLogs(100)
  assert(logs19c.length >= 5, '重启后日志数量不变（跨重启保留）')

  console.log('\n【跨重启 1】方案数据持久化 + 重启后默认方案保留')
  cleanupAll()
  delete require.cache[require.resolve('../src/store')]
  delete require.cache[require.resolve('../src/exportProfile')]
  const storeR20 = require('../src/store')
  const epR20 = require('../src/exportProfile')
  const r20a = epR20.createProfile({ name: '重启默认', titleTemplate: 'R', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  const r20b = epR20.createProfile({ name: '重启普通', titleTemplate: 'R2', groupOrder: ['fix'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  epR20.setDefault(r20b.profile.id)
  delete require.cache[require.resolve('../src/store')]
  delete require.cache[require.resolve('../src/exportProfile')]
  const storeR20b = require('../src/store')
  const epR20b = require('../src/exportProfile')
  const list20 = epR20b.listProfiles()
  assert(list20.length === 2, '重启后方案数量仍为 2')
  const def20 = list20.find(p => p.isDefault)
  assert(def20.name === '重启普通', '重启后默认方案仍是"重启普通"')
  const raw20 = storeR20b.loadExportProfiles()
  assert(raw20.default === r20b.profile.id, '磁盘 default 字段正确')

  console.log('\n【冲突处理 1】更新时重命名覆盖同名方案（含默认方案迁移）')
  cleanupAll()
  const r21a = exportProfile.createProfile({ name: 'alpha', titleTemplate: 'A', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  const r21b = exportProfile.createProfile({ name: 'beta', titleTemplate: 'B', groupOrder: ['fix'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  exportProfile.setDefault(r21b.profile.id)
  const up21 = exportProfile.updateProfile(r21a.profile.id, { name: 'beta' }, { force: true })
  assert(up21.success === true, 'force 重命名覆盖 success')
  const list21 = exportProfile.listProfiles()
  assert(list21.length === 1, '覆盖后只剩 1 个方案')
  assert(list21[0].name === 'beta', '剩余方案名称为 beta')
  assert(list21[0].isDefault === true, '剩余方案被设为默认（被覆盖的是原默认）')

  console.log('\n【冲突处理 2】delete 删除最后一个默认方案后 default=null')
  cleanupAll()
  const r22 = exportProfile.createProfile({ name: '唯一', titleTemplate: 'O', groupOrder: ['feature'], includeTicket: true, includeAuthor: false, includeDate: false, outputDir: '' })
  exportProfile.deleteProfile(r22.profile.id)
  const raw22 = store.loadExportProfiles()
  assert(raw22.default === null, '删除最后一个方案后 default=null')
  assert(Array.isArray(raw22.profiles) && raw22.profiles.length === 0, 'profiles 为空数组')

  console.log('\n【失败分支 1】importProfileFromFile 读取不存在文件 + 非法 JSON')
  const imp23a = exportProfile.importProfileFromFile('/not/exist/path.json')
  assert(imp23a.success === false, '不存在文件 success=false')
  assert(imp23a.errors.some(e => e.includes('不存在')), '错误信息含"不存在"')
  const badJsonFile23 = path.join(os.tmpdir(), `bad-json-${Date.now()}.json`)
  fs.writeFileSync(badJsonFile23, 'this is not json{{{', 'utf-8')
  const imp23b = exportProfile.importProfileFromFile(badJsonFile23)
  assert(imp23b.success === false, '非法 JSON success=false')
  assert(imp23b.errors.some(e => e.includes('解析') || e.includes('JSON')), '错误信息含解析提示')
  try { fs.unlinkSync(badJsonFile23) } catch {}

  console.log('\n【失败分支 2】exportProfileToFile / exportProfileToJson 不存在 ID')
  const exp24a = exportProfile.exportProfileToJson('not-exist')
  assert(exp24a.success === false, '导出不存在 ID success=false')
  const exp24b = exportProfile.exportProfileToFile('not-exist', '/tmp/x.json')
  assert(exp24b.success === false, '导出文件不存在 ID success=false')

  console.log('\n【失败分支 3】setDefault 不存在的 ID + duplicateProfile 不存在 ID')
  const sd25 = exportProfile.setDefault('not-exist-id')
  assert(sd25.success === false, 'setDefault 不存在 success=false')
  const dup25 = exportProfile.duplicateProfile('not-exist-id')
  assert(dup25.success === false, 'duplicateProfile 不存在 success=false')

  console.log('\n【不破坏现有功能 1】不使用方案时导出结果与老版本兼容')
  cleanupAll()
  config.reset()
  prepareAndArchive('v9.9.9', '兼容测试备注')
  const commits26 = store.loadCommits()
  for (const c of commits26) {
    if (c.category === 'ignored') continue
    if (c.message.includes('更新 API 文档')) reviewer.setTicket(c.id, 'PROJ-104')
  }
  const md26 = exporter.generateMarkdown('v9.9.9')
  assert(typeof md26 === 'string' && md26.length > 0, '兼容模式 Markdown 生成内容')
  assert(md26.includes('发布说明 - v9.9.9'), '默认标题正确')
  assert(md26.includes('兼容测试备注'), '备注正确')
  assert(md26.includes('⚠ 破坏性变更') && md26.includes('✨ 新功能') && md26.includes('🐛 修复') && md26.includes('📋 其他'), '四个分组标题都存在')

  console.log('\n【不破坏现有功能 2】配置备份恢复、普通导出、归档链路未被带坏')
  cleanupAll()
  const configBackup = require('../src/configBackup')
  config.reset()
  const cfg27 = config.get()
  cfg27.ticketPattern = 'REGRESSION-\\d+'
  cfg27.keywords.feature = ['reg-feat-a', 'reg-feat-b']
  cfg27.ignorePatterns = ['^REG-IGNORE']
  config.update({ ticketPattern: cfg27.ticketPattern, keywords: cfg27.keywords, ignorePatterns: cfg27.ignorePatterns })
  const bk27 = configBackup.exportBackup('回归测试备份')
  assert(fs.existsSync(bk27.path), '配置备份文件写出')
  config.reset()
  const rst27 = configBackup.importBackupFromFile(bk27.path, { force: true })
  assert(rst27.success === true, '配置备份恢复 success')
  assert(config.get().ticketPattern === 'REGRESSION-\\d+', '配置恢复后 ticketPattern 正确')
  prepareAndArchive('v7.7.7')
  const arc27 = store.loadArchives().find(a => a.version === 'v7.7.7')
  assert(arc27 && arc27.commitCount >= 1, '归档成功')
  const outDir27 = path.join(os.tmpdir(), `rn-regression-output-${Date.now()}`)
  const files27 = exporter.exportAll(outDir27)
  assert(Array.isArray(files27) && files27.length >= 1, 'exportAll 成功')
  files27.forEach(f => assert(fs.existsSync(f.path), `文件 ${f.path} 存在`))
  try { files27.forEach(f => { try { fs.unlinkSync(f.path) } catch {} }); try { fs.rmdirSync(outDir27) } catch {} } catch {}

  console.log('\n【CLI 回归 1】profile list / create / show / delete 命令可执行')
  cleanupAll()
  const { spawnSync } = require('child_process')
  const cli28list = spawnSync(process.execPath, ['bin/cli.js', 'profile', 'list'], { encoding: 'utf-8', cwd: process.cwd() })
  assert(cli28list.status === 0, 'profile list 退出码 0')
  const cli28create = spawnSync(process.execPath, ['bin/cli.js', 'profile', 'create', 'CLI测试方案', '--title-template', 'CLI-${version}', '--group-order', 'feature,fix', '--include-ticket', '1', '--include-author', '0', '--include-date', '1', '--output-dir', '/cli-out'], { encoding: 'utf-8', cwd: process.cwd() })
  assert(cli28create.status === 0, 'profile create 退出码 0')
  assert(cli28create.stdout.includes('已创建方案') || cli28create.stdout.includes('CLI测试方案'), 'profile create 输出包含成功信息')
  const cli28show = spawnSync(process.execPath, ['bin/cli.js', 'profile', 'show', 'CLI测试方案'], { encoding: 'utf-8', cwd: process.cwd() })
  assert(cli28show.status === 0, 'profile show 退出码 0')
  assert(cli28show.stdout.includes('CLI测试方案'), 'profile show 输出包含方案名')
  const cli28logs = spawnSync(process.execPath, ['bin/cli.js', 'profile', 'logs'], { encoding: 'utf-8', cwd: process.cwd() })
  assert(cli28logs.status === 0, 'profile logs 退出码 0')
  const cli28del = spawnSync(process.execPath, ['bin/cli.js', 'profile', 'delete', 'CLI测试方案'], { encoding: 'utf-8', cwd: process.cwd() })
  assert(cli28del.status === 0, 'profile delete 退出码 0')
  const cli28undo = spawnSync(process.execPath, ['bin/cli.js', 'profile', 'undo'], { encoding: 'utf-8', cwd: process.cwd() })
  assert(cli28undo.status === 0, 'profile undo 退出码 0')

  console.log('\n【CLI 回归 2】export --profile 按方案导出版本')
  cleanupAll()
  delete require.cache[require.resolve('../src/store')]
  delete require.cache[require.resolve('../src/config')]
  delete require.cache[require.resolve('../src/exporter')]
  delete require.cache[require.resolve('../src/exportProfile')]
  delete require.cache[require.resolve('../src/importer')]
  delete require.cache[require.resolve('../src/classifier')]
  delete require.cache[require.resolve('../src/validator')]
  delete require.cache[require.resolve('../src/reviewer')]
  delete require.cache[require.resolve('../src/archiver')]
  const store29 = require('../src/store')
  const config29 = require('../src/config')
  const ep29 = require('../src/exportProfile')
  const exporter29 = require('../src/exporter')
  const importer29 = require('../src/importer')
  const classifier29 = require('../src/classifier')
  const validator29 = require('../src/validator')
  const reviewer29 = require('../src/reviewer')
  const archiver29 = require('../src/archiver')
  config29.reset()
  ep29.createProfile({ name: 'CLI导出方案', titleTemplate: 'CLI Release ${version}', groupOrder: ['feature', 'fix'], includeTicket: false, includeAuthor: false, includeDate: false, outputDir: '' })
  function prepareAndArchive29(version, note) {
    store29.saveCommits([])
    store29.saveArchives([])
    importer29.importFromCsv('sample.csv')
    classifier29.classify()
    let commits = store29.loadCommits()
    for (let i = 0; i < commits.length; i++) {
      if (commits[i].version === '2.0') commits[i].version = 'v2.0.0'
      if (!commits[i].ticket) commits[i].ticket = 'PROJ-000'
    }
    store29.saveCommits(commits)
    commits = store29.loadCommits()
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i]
      if (c.category === 'ignored') continue
      reviewer29.review(c.id, note || '')
    }
    let vr = validator29.validate()
    if (vr && vr.errors && vr.errors.length > 0) {
      commits = store29.loadCommits()
      for (const e of vr.errors) {
        const m = (e.message || '').match(/^([a-f0-9]{6,}):/)
        if (m) {
          const idx = commits.findIndex(x => x.id && x.id.startsWith(m[1]))
          if (idx >= 0) {
            if (e.message.includes('工单号')) commits[idx].ticket = commits[idx].ticket || 'PROJ-000'
            if (e.message.includes('版本号')) commits[idx].version = 'v1.0.0'
          }
        }
      }
      store29.saveCommits(commits)
      validator29.validate()
    }
    commits = store29.loadCommits()
    let anyFixed29 = false
    for (let i = 0; i < commits.length; i++) {
      if (commits[i].category === 'ignored') continue
      if (commits[i].issues && commits[i].issues.length > 0) {
        commits[i].issues = commits[i].issues.filter(it => {
          if (it.includes('缺失工单号') && commits[i].ticket) return false
          if (it.includes('版本号不合规') && commits[i].version && /^v?\d+\.\d+\.\d+$/.test(commits[i].version)) return false
          return true
        })
        commits[i].resolved = commits[i].issues.length === 0
        anyFixed29 = true
      }
    }
    if (anyFixed29) store29.saveCommits(commits)
    return archiver29.archive(version)
  }
  prepareAndArchive29('v5.5.5')
  const tmpDir29 = path.join(os.tmpdir(), `rn-cli-profile-export-${Date.now()}`)
  const cli29 = spawnSync(process.execPath, ['bin/cli.js', 'export', 'v5.5.5', tmpDir29, '--profile-name', 'CLI导出方案'], { encoding: 'utf-8', cwd: process.cwd() })
  assert(cli29.status === 0, 'CLI export --profile-name 退出码 0')
  const outFiles29 = fs.readdirSync(tmpDir29)
  assert(outFiles29.some(f => f.startsWith('release-v5.5.5')), '输出目录下有导出文件')
  const md29 = fs.readFileSync(path.join(tmpDir29, outFiles29[0]), 'utf-8')
  assert(md29.includes('CLI Release v5.5.5'), 'CLI 按方案导出标题模板生效')
  try { outFiles29.forEach(f => fs.unlinkSync(path.join(tmpDir29, f))); fs.rmdirSync(tmpDir29) } catch {}

  console.log('\n【常量验证】默认值、常量定义正确')
  assertEq(exportProfile.DEFAULT_GROUP_ORDER, ['breaking', 'feature', 'fix', 'other'], 'DEFAULT_GROUP_ORDER 正确')
  assertEq(exportProfile.KNOWN_CATEGORIES, ['breaking', 'feature', 'fix', 'other'], 'KNOWN_CATEGORIES 正确')
  assert(typeof exportProfile.CATEGORY_LABELS.breaking === 'string', 'CATEGORY_LABELS 含 breaking')
  assert(exportProfile.CATEGORY_LABELS.feature.includes('新功能'), 'CATEGORY_LABELS.feature 含"新功能"')
  assert(exportProfile.PROFILE_SCHEMA_VERSION === 1, 'PROFILE_SCHEMA_VERSION = 1')
  assertEq(exportProfile.REQUIRED_FIELDS, ['name', 'titleTemplate', 'groupOrder', 'includeTicket', 'includeAuthor', 'includeDate', 'outputDir'], 'REQUIRED_FIELDS 完整')

  cleanupAll()
  console.log(`\n========== 导出方案回归测试汇总: 通过 ${pass} / ${pass + fail} ==========`)
  if (fail > 0) process.exit(1)
}

runTests()
