const http = require('http')
const path = require('path')
const fs = require('fs')
const store = require('../src/store')

const PORT = 3000

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    }
    const req = http.request(options, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, json: data ? JSON.parse(data) : null }) }
        catch { resolve({ statusCode: res.statusCode, json: null, raw: data }) }
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function fullChainTest() {
  let pass = 0, fail = 0
  const assert = (cond, msg) => {
    if (cond) { pass++; console.log(`  ✓ ${msg}`) }
    else { fail++; console.error(`  ✗ ${msg}`) }
  }

  console.log('\n== Web API 全链路验证 (端口 3000) ==')

  console.log('\n1. 首页 GET /')
  const r1 = await request('GET', '/')
  assert(r1.statusCode === 200, `首页200实际${r1.statusCode}`)

  console.log('\n2. 导入 CSV POST /api/import/csv')
  const r2 = await request('POST', '/api/import/csv', { file: 'sample.csv' })
  assert(r2.statusCode === 200, `导入API200实际${r2.statusCode}`)
  assert(r2.json.added === 5, `新增5实际${r2.json.added}`)
  assert(r2.json.duplicates === 0, `重复0实际${r2.json.duplicates}`)

  console.log('\n3. 自动分类 POST /api/classify')
  const r3 = await request('POST', '/api/classify')
  assert(r3.statusCode === 200, `分类API200实际${r3.statusCode}`)
  assert(r3.json.feature === 1, `feature=1实际${r3.json.feature}`)
  assert(r3.json.fix === 1, `fix=1实际${r3.json.fix}`)
  assert(r3.json.breaking === 1, `breaking=1实际${r3.json.breaking}`)

  console.log('\n4. 获取列表 GET /api/commits')
  const r4 = await request('GET', '/api/commits')
  assert(r4.statusCode === 200, `列表API200实际${r4.statusCode}`)
  assert(r4.json.length === 5, `列表5条实际${r4.json.length}`)
  const commits = r4.json
  const missingTicket = commits.find(c => c.message.includes('更新 API 文档'))
  assert(missingTicket && missingTicket.issues.includes('缺失工单号'), '缺工单的提交应被标记')
  const ignored = commits.find(c => c.message.includes('更新依赖版本'))
  assert(ignored && ignored.category === 'ignored', `chore前缀的提交应被ignore，实际category=${ignored ? ignored.category : '未找到'}`)

  console.log('\n5. 缺失工单的提交不能归档 - 验证校验拦截')
  const r5 = await request('GET', '/api/validate')
  assert(r5.statusCode === 200, `validate API 200实际${r5.statusCode}`)
  const r5b = await request('POST', '/api/archive', { version: 'v1.2.0' })
  assert(r5b.statusCode !== 200, `存在未解决问题时归档应该失败实际却成功了`)
  console.log(`   正确拦截，返回状态码: ${r5b.statusCode}`)

  console.log('\n6. 先用 set-category 改分类，再撤销，验证链路完整')
  const c = commits[0]
  const oldCat = c.category
  const r6 = await request('POST', '/api/commits/category', { id: c.id, category: 'breaking' })
  assert(r6.statusCode === 200, `set-category API 200实际${r6.statusCode}`)
  assert(r6.json.category === 'breaking', `分类改为breaking`)

  const r6b = await request('GET', '/api/undo/peek')
  assert(r6b.json.type === 'set-category', `栈顶是set-category实际是${r6b.json.type}`)
  console.log(`   栈顶正确: ${r6b.json.type} / ${r6b.json.description}`)

  const r6c = await request('POST', '/api/undo')
  assert(r6c.json.success === true, `撤销set-category成功`)
  assert(r6c.json.action === 'set-category', `撤销的动作正确`)

  const r6d = await request('GET', '/api/commits')
  const cAfter = r6d.json.find(x => x.id === c.id)
  assert(cAfter.category === oldCat, `撤销后category应恢复为${oldCat}实际为${cAfter.category}`)
  console.log(`   撤销后category正确恢复: ${oldCat}`)

  console.log('\n7. 给缺工单的提交设置工单并复核所有')
  const missing = r6d.json.find(x => x.message.includes('更新 API 文档'))
  const r7a = await request('POST', '/api/commits/ticket', { id: missing.id, ticket: 'PROJ-104' })
  assert(r7a.statusCode === 200, `set-ticket API 200实际${r7a.statusCode}`)
  assert(r7a.json.ticket === 'PROJ-104', '工单设置成功')
  assert(!r7a.json.issues.includes('缺失工单号'), '工单问题应被清除')

  for (const cc of r6d.json) {
    if (cc.category === 'ignored') continue
    const note = cc.id.startsWith('abc') ? '重要新功能' : cc.id.startsWith('def') ? '已修复并验证' : ''
    const r = await request('POST', '/api/commits/review', { id: cc.id, note })
    assert(r.statusCode === 200, `复核${cc.id.substring(0,7)}成功`)
  }

  console.log('\n8. 归档并导出')
  const r8 = await request('POST', '/api/archive', { version: 'v1.2.0' })
  assert(r8.statusCode === 200, `归档返回200实际${r8.statusCode}`)
  assert(r8.json.commitCount >= 3, `归档至少3条实际${r8.json.commitCount}`)

  const r9 = await request('POST', '/api/export', { version: 'v1.2.0' })
  assert(r9.statusCode === 200, `导出API返回200`)
  assert(r9.json.markdown.includes('abc1234'), 'MD含hash')
  assert(r9.json.markdown.includes('重要新功能'), 'MD含人工备注')
  assert(r9.json.markdown.includes('破坏性变更') || r9.json.markdown.includes('新功能'), 'MD有正确栏目')
  assert(!r9.json.markdown.includes('更新依赖版本'), '被ignore的提交不应出现在MD中')

  console.log('\n9. 验证撤销栈空时明确报错')
  while (true) {
    const r = await request('POST', '/api/undo')
    if (!r.json.success) {
      assert(r.json.reason === '没有历史可撤销: 撤销栈为空', `栈空时报文精确，实际=${r.json.reason}`)
      console.log(`   栈空时报文正确: ${r.json.reason}`)
      break
    }
  }

  console.log(`\n========== 汇总: 通过 ${pass} / ${pass + fail} ==========`)
  process.exit(fail > 0 ? 1 : 0)
}

fullChainTest()
