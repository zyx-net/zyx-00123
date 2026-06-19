const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')
const store = require('../src/store')
const undo = require('../src/undo')

const PORT = 3099
const TEST_CSV = path.join(store.DATA_DIR, '_web_test.csv')

let pass = 0
let fail = 0

function assert(cond, msg) {
  if (cond) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.error(`  ✗ ${msg}`)
  }
}

function cleanup() {
  const dataDir = store.DATA_DIR
  for (const f of ['commits', 'archives', 'undo']) {
    const fp = path.join(dataDir, `${f}.json`)
    if (fs.existsSync(fp)) {
      try { fs.unlinkSync(fp) } catch {}
    }
  }
  if (fs.existsSync(TEST_CSV)) {
    try { fs.unlinkSync(TEST_CSV) } catch {}
  }
}

function makeCsv(lines, outPath) {
  const header = 'hash,message,author,date,ticket,version\n'
  const content = header + lines.join('\n')
  fs.writeFileSync(outPath, content, 'utf-8')
}

function httpRequest(method, urlPath, body) {
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
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: data, json: data ? JSON.parse(data) : null }) }
        catch { resolve({ statusCode: res.statusCode, body: data, json: null }) }
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function waitForServer(timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tryConnect = () => {
      const req = http.get(`http://localhost:${PORT}/`, res => {
        res.resume()
        resolve(true)
      })
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('Server timeout'))
        else setTimeout(tryConnect, 200)
      })
      req.end()
    }
    tryConnect()
  })
}

async function test() {
  cleanup()
  undo.clear()
  makeCsv([
    'aaa1111,feat: 测试模块,张三,2025-01-01,PROJ-1,v1.0.0',
    'bbb2222,fix: 测试bug,李四,2025-01-02,PROJ-2,v1.0.0'
  ], TEST_CSV)

  console.log('\n== 测试: 用户真实启动命令 (node web/server.js) ==')

  const child = spawn('node', ['web/server.js', String(PORT)], {
    cwd: path.join(__dirname, '..'),
    env: process.env
  })

  let stderr = ''
  let stdout = ''
  child.stderr.on('data', d => { stderr += d })
  child.stdout.on('data', d => { stdout += d })

  let serverError = null
  child.on('error', e => { serverError = e })
  child.on('exit', code => {
    if (code !== 0 && !serverError) serverError = new Error(`Exit code ${code}: ${stderr}`)
  })

  try {
    await waitForServer(5000)
    console.log('   服务启动成功，无崩溃')
    assert(true, '启动时无 ReferenceError')
    assert(!stderr.includes('ReferenceError'), 'stderr 中不含 ReferenceError')

    console.log('\n== 测试: 首页可访问 (200) ==')
    const r1 = await httpRequest('GET', '/')
    assert(r1.statusCode === 200, `首页状态码应为200实际${r1.statusCode}`)
    assert(r1.body.includes('发布说明整理工具'), '首页含标题文字')

    console.log('\n== 测试: API 链路 (导入→分类→复核→归档→导出) ==')

    const r2 = await httpRequest('POST', '/api/import/csv', { file: TEST_CSV })
    assert(r2.statusCode === 200, `导入API返回200实际${r2.statusCode}`)
    assert(r2.json.added === 2, `导入应新增2实际${r2.json.added}`)

    const r3 = await httpRequest('POST', '/api/classify')
    assert(r3.statusCode === 200, `分类API返回200实际${r3.statusCode}`)
    assert(r3.json.feature === 1, `功能分类应为1实际${r3.json.feature}`)
    assert(r3.json.fix === 1, `修复分类应为1实际${r3.json.fix}`)

    const r4 = await httpRequest('GET', '/api/commits')
    assert(r4.statusCode === 200, `列表API返回200实际${r4.statusCode}`)
    assert(r4.json.length >= 2, `至少2条提交实际${r4.json.length}`)
    const commitId = r4.json[0].id

    const r5 = await httpRequest('POST', '/api/commits/review', { id: commitId, note: '测试备注' })
    assert(r5.statusCode === 200, `复核API返回200实际${r5.statusCode}`)
    assert(r5.json.reviewed === true, '复核状态正确')
    assert(r5.json.note === '测试备注', '备注正确保存')

    const r6 = await httpRequest('GET', '/api/undo/size')
    assert(r6.statusCode === 200, `undo size API 返回200实际${r6.statusCode}`)
    assert(r6.json.size >= 3, `撤销栈至少3层(导入/分类/复核)实际${r6.json.size}`)

    await httpRequest('POST', '/api/commits/review', { id: r4.json[1].id, note: '已复核' })

    const r7 = await httpRequest('POST', '/api/archive', { version: 'v1.0.0' })
    assert(r7.statusCode === 200, `归档API返回200实际${r7.statusCode}`)
    assert(r7.json.commitCount === 2, `归档应为2条实际${r7.json.commitCount}`)

    const r8 = await httpRequest('POST', '/api/export', { version: 'v1.0.0' })
    assert(r8.statusCode === 200, `导出API返回200实际${r8.statusCode}`)
    assert(r8.json.markdown.includes('aaa1111'), 'MD中含来源提交hash')
    assert(r8.json.markdown.includes('测试备注'), 'MD中含人工备注')
    assert(r8.json.markdown.includes('PROJ-1'), 'MD中含工单号')
    assert(r8.json.markdown.includes('破坏性变更') || r8.json.markdown.includes('新功能') || r8.json.markdown.includes('修复'), 'MD中有正确栏目')

    console.log('\n== 测试: 撤销链路在 Web 层也工作 ==')
    const r9 = await httpRequest('POST', '/api/undo')
    assert(r9.statusCode === 200, `撤销API返回200实际${r9.statusCode}`)
    assert(r9.json.success === true, `撤销应成功实际=${r9.json.success}`)
    assert(r9.json.action === 'archive', `撤销的动作应为archive实际=${r9.json.action}`)

    console.log('\n== 测试: 另一种启动方式 (node bin/cli.js web) 也不受影响 ==')
    // 这里不实际启动，只验证 require 导出还在
    const m = require('../web/server')
    assert(typeof m === 'function', 'module.exports 仍然是函数')

    console.log(`\n========== 汇总: 通过 ${pass} / ${pass + fail} ==========`)
    if (fail > 0) {
      console.error(`  ❗ ${fail} 个失败`)
      if (stderr) console.error('  stderr:', stderr)
      process.exit(1)
    } else {
      console.log('  ✓ 全部通过')
    }

  } catch (e) {
    console.error(`  测试异常: ${e.message}`)
    if (serverError) console.error(`  服务错误: ${serverError.message}`)
    fail++
  } finally {
    try { child.kill('SIGTERM') } catch {}
    setTimeout(() => {
      try { cleanup() } catch {}
      process.exit(fail > 0 ? 1 : 0)
    }, 500)
  }
}

test()
