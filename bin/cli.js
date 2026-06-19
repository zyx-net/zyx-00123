#!/usr/bin/env node

const path = require('path')
const config = require('../src/config')
const importer = require('../src/importer')
const classifier = require('../src/classifier')
const validator = require('../src/validator')
const reviewer = require('../src/reviewer')
const undo = require('../src/undo')
const archiver = require('../src/archiver')
const exporter = require('../src/exporter')
const store = require('../src/store')

const args = process.argv.slice(2)
const cmd = args[0] || 'help'

function out(msg) {
  console.log(msg)
}

function err(msg) {
  console.error('\x1b[31m' + msg + '\x1b[0m')
}

function ok(msg) {
  console.log('\x1b[32m' + msg + '\x1b[0m')
}

function yellow(msg) {
  console.log('\x1b[33m' + msg + '\x1b[0m')
}

function printCommit(c) {
  const status = c.reviewed ? '✓' : '○'
  const resolved = c.resolved ? '✔' : (c.issues && c.issues.length > 0 ? '✘' : '-')
  out(`  [${status}][${resolved}] ${c.id.substring(0, 8)} | ${c.category.padEnd(8)} | ${c.message}`)
  if (c.ticket) out(`    工单: ${c.ticket}`)
  if (c.version) out(`    版本: ${c.version}`)
  if (c.note) out(`    备注: ${c.note}`)
  if (c.issues && c.issues.length > 0) {
    c.issues.forEach((issue, i) => yellow(`    ⚠ [${i}] ${issue}`))
  }
  out(`    来源: ${c.source} | ${c.author} | ${c.date}`)
}

function printHelp() {
  out(`
发布说明整理工具 (rn)
=====================

命令列表:

  配置管理:
    config show                          显示当前规则配置
    config set <key> <value>             设置配置项 (支持 ticketPattern, versionPattern, versionPrefix)
    config keywords <category> <words>   设置分类关键字 (逗号分隔)
    config ignore <patterns>             设置忽略模式 (逗号分隔)
    config reset                         恢复默认配置

  导入提交:
    import git [dir]                     从指定目录导入 git log (默认当前目录)
    import csv <file>                    从 CSV 文件导入提交记录

  自动分类:
    classify                             按规则自动分类所有提交
    set-category <id> <category>         手动设置提交分类 (feature|fix|breaking|other|ignored)
    set-version <id> <version>           手动设置提交目标版本号

  校验:
    validate                            校验所有提交 (重复、缺失工单号、版本号格式)
    resolve <id> <issueIndex>            标记某条校验问题为已解决

  人工复核:
    review <id> [note]                   复核通过并附注说明
    batch-review <ids...> --note <note>  批量复核 (ids 逗号分隔)
    unreview <id>                        撤销复核
    set-ticket <id> <ticket>             手动设置工单号
    list [category]                      列出提交 (可选 feature|fix|breaking|other|unresolved|unreviewed)

  撤销:
    undo                                 撤销上一步操作
    undo-peek                            查看可撤销的操作
    undo-size                            查看撤销栈深度

  归档与导出:
    archive <version>                    归档版本 (仅允许全部复核且无未解决问题)
    archives                             列出已归档版本
    export <version> [outputDir]         导出版本发布说明为 Markdown
    export-all [outputDir]               导出所有已归档版本

  其他:
    web [port]                           启动 Web 界面 (默认 3000)
    help                                  显示此帮助信息

样例输入:
  git log 格式: 自动解析 git log --pretty=format 输出
  CSV 格式 (需含表头):
    hash,message,author,date,ticket,version
    abc123,feat: 新增用户管理,张三,2025-01-01,PROJ-101,v1.2.0
    def456,fix: 修复登录超时,李四,2025-01-02,PROJ-102,v1.2.0
    789abc,breaking: 移除旧 API,王五,2025-01-03,PROJ-103,v1.3.0
`)
}

function run() {
  switch (cmd) {
    case 'help': {
      printHelp()
      break
    }

    case 'config': {
      const sub = args[1]
      if (sub === 'show') {
        const cfg = config.get()
        out(JSON.stringify(cfg, null, 2))
      } else if (sub === 'set') {
        const key = args[2]
        const value = args[3]
        if (!key || !value) { err('用法: config set <key> <value>'); break }
        const updated = config.update({ [key]: value })
        ok(`已更新 ${key} = ${value}`)
      } else if (sub === 'keywords') {
        const category = args[2]
        const words = args[3]
        if (!category || !words) { err('用法: config keywords <category> <words>'); break }
        const keywords = config.get().keywords
        keywords[category] = words.split(',')
        config.update({ keywords })
        ok(`已设置 ${category} 关键字: ${words}`)
      } else if (sub === 'ignore') {
        const patterns = args[2]
        if (!patterns) { err('用法: config ignore <patterns>'); break }
        config.update({ ignorePatterns: patterns.split(',') })
        ok(`已设置忽略模式: ${patterns}`)
      } else if (sub === 'reset') {
        config.reset()
        ok('已恢复默认配置')
      } else {
        err('未知 config 子命令。使用: show | set | keywords | ignore | reset')
      }
      break
    }

    case 'import': {
      const source = args[1]
      if (source === 'git') {
        const gitDir = args[2] || '.'
        const result = importer.importFromGit(gitDir)
        ok(`导入完成: 新增 ${result.added} 条, 重复 ${result.duplicates} 条, 共 ${result.total} 条`)
        if (result.duplicates > 0) {
          yellow(`发现 ${result.duplicates} 条重复提交已跳过`)
        }
      } else if (source === 'csv') {
        const file = args[2]
        if (!file) { err('用法: import csv <file>'); break }
        const result = importer.importFromCsv(file)
        ok(`导入完成: 新增 ${result.added} 条, 重复 ${result.duplicates} 条, 共 ${result.total} 条`)
        if (result.duplicates > 0) {
          yellow(`发现 ${result.duplicates} 条重复提交已跳过`)
        }
      } else {
        err('用法: import git [dir] | import csv <file>')
      }
      break
    }

    case 'classify': {
      const result = classifier.classify()
      ok(`分类完成: 功能=${result.feature} 修复=${result.fix} 破坏性=${result.breaking} 其他=${result.other} 忽略=${result.ignored}`)
      break
    }

    case 'set-category': {
      const id = args[1]
      const category = args[2]
      if (!id || !category) { err('用法: set-category <id> <category>'); break }
      const c = classifier.setCategory(id, category)
      ok(`已设置 ${id.substring(0, 8)} 分类为 ${category}`)
      break
    }

    case 'set-version': {
      const id = args[1]
      const version = args[2]
      if (!id || !version) { err('用法: set-version <id> <version>'); break }
      const c = classifier.setVersion(id, version)
      ok(`已设置 ${id.substring(0, 8)} 版本为 ${version}`)
      break
    }

    case 'validate': {
      const result = validator.validate()
      if (result.errors.length === 0 && result.warnings.length === 0) {
        ok('校验通过，无异常')
      } else {
        if (result.errors.length > 0) {
          err(`错误 (${result.errors.length}):`)
          result.errors.forEach(e => err(`  ${e.message}`))
        }
        if (result.warnings.length > 0) {
          yellow(`警告 (${result.warnings.length}):`)
          result.warnings.forEach(w => yellow(`  ${w.message}`))
        }
      }
      break
    }

    case 'resolve': {
      const id = args[1]
      const issueIndex = parseInt(args[2], 10)
      if (!id || isNaN(issueIndex)) { err('用法: resolve <id> <issueIndex>'); break }
      const c = validator.resolveIssue(id, issueIndex)
      ok(`已解决 ${id.substring(0, 8)} 的第 ${issueIndex} 条问题`)
      break
    }

    case 'review': {
      const id = args[1]
      const note = args.slice(2).join(' ')
      if (!id) { err('用法: review <id> [note]'); break }
      const c = reviewer.review(id, note)
      ok(`已复核 ${id.substring(0, 8)}${note ? ` 备注: ${note}` : ''}`)
      break
    }

    case 'batch-review': {
      const idsStr = args[1]
      if (!idsStr) { err('用法: batch-review <ids,comma,sep> --note <note>'); break }
      const ids = idsStr.split(',')
      const noteIdx = args.indexOf('--note')
      const note = noteIdx >= 0 ? args.slice(noteIdx + 1).join(' ') : ''
      const count = reviewer.batchReview(ids, note)
      ok(`已批量复核 ${count} 条提交`)
      break
    }

    case 'unreview': {
      const id = args[1]
      if (!id) { err('用法: unreview <id>'); break }
      const c = reviewer.unreview(id)
      ok(`已撤销复核 ${id.substring(0, 8)}`)
      break
    }

    case 'set-ticket': {
      const id = args[1]
      const ticket = args[2]
      if (!id || !ticket) { err('用法: set-ticket <id> <ticket>'); break }
      const c = reviewer.setTicket(id, ticket)
      ok(`已设置 ${id.substring(0, 8)} 工单号为 ${ticket}`)
      break
    }

    case 'list': {
      const category = args[1]
      const commits = store.loadCommits()
      if (category === 'unresolved') {
        const list = reviewer.listUnresolved()
        out(`未解决问题 (${list.length}):`)
        list.forEach(printCommit)
      } else if (category === 'unreviewed') {
        const list = reviewer.listUnreviewed()
        out(`未复核 (${list.length}):`)
        list.forEach(printCommit)
      } else if (category) {
        const list = reviewer.listByCategory(category)
        out(`${category} (${list.length}):`)
        list.forEach(printCommit)
      } else {
        out(`全部提交 (${commits.length}):`)
        commits.forEach(printCommit)
      }
      break
    }

    case 'undo': {
      const result = undo.pop()
      if (!result.success) {
        err(result.reason)
      } else {
        ok(`已撤销: [${result.action}] ${result.description} (操作时间: ${result.timestamp})`)
      }
      break
    }

    case 'undo-peek': {
      const top = undo.peek()
      if (!top) {
        yellow('撤销栈为空')
      } else {
        out(`可撤销: [${top.type}] ${top.description} (${top.timestamp})`)
      }
      break
    }

    case 'undo-size': {
      out(`撤销栈深度: ${undo.size()}`)
      break
    }

    case 'archive': {
      const version = args[1]
      if (!version) { err('用法: archive <version>'); break }
      try {
        const snapshot = archiver.archive(version)
        ok(`已归档版本 ${version}: ${snapshot.commitCount} 条提交`)
      } catch (e) {
        err(`归档失败: ${e.message}`)
      }
      break
    }

    case 'archives': {
      const list = archiver.listArchives()
      if (list.length === 0) {
        yellow('尚无已归档版本')
      } else {
        out('已归档版本:')
        list.forEach(a => out(`  ${a.version} | ${a.date} | ${a.commitCount} 条提交`))
      }
      break
    }

    case 'export': {
      const version = args[1]
      const outputDir = args[2]
      if (!version) { err('用法: export <version> [outputDir]'); break }
      try {
        const fp = exporter.exportToFile(version, outputDir)
        ok(`已导出: ${fp}`)
      } catch (e) {
        err(`导出失败: ${e.message}`)
      }
      break
    }

    case 'export-all': {
      const outputDir = args[1]
      try {
        const files = exporter.exportAll(outputDir)
        if (files.length === 0) {
          yellow('没有可导出的已归档版本')
        } else {
          ok(`已导出 ${files.length} 个文件:`)
          files.forEach(f => out(`  ${f}`))
        }
      } catch (e) {
        err(`导出失败: ${e.message}`)
      }
      break
    }

    case 'web': {
      const port = parseInt(args[1], 10) || 3000
      require('../web/server')(port)
      break
    }

    default:
      err(`未知命令: ${cmd}`)
      printHelp()
  }
}

run()
