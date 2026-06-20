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
const configBackup = require('../src/configBackup')
const exportProfile = require('../src/exportProfile')
const draft = require('../src/draft')

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
    config backup [name]                 导出当前配置为备份文件 (可选自定义名称)
    config backup-list                   列出所有配置备份
    config backup-delete <filename>      删除指定备份文件
    config diff <filename|path>          查看备份与当前配置的逐项差异
    config restore <filename|path>       从备份文件恢复配置
      可选: --fields f1,f2,...         仅恢复指定字段 (按项恢复)
      可选: --force                     强制恢复 (即使内容重复或存在冲突)
      可选: --dry-run                   仅预览，不实际写入
    config restore-peek                  查看最近一次恢复的撤销信息
    config undo-restore                  撤销最近一次配置恢复
    config restore-logs [n]              查看最近 n 条恢复日志 (默认 10)
    config validate-file <path>          校验备份文件格式

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
      可选: --profile <name|id>         使用指定方案导出
      可选: --profile-id <id>           按方案ID导出
      可选: --profile-name <name>       按方案名导出
    export-all [outputDir]               导出所有已归档版本
      可选: --profile <name|id>         使用指定方案导出
      可选: --profile-id <id>           按方案ID导出
      可选: --profile-name <name>       按方案名导出

  导出方案管理:
    profile list                         列出所有导出方案
    profile show <name|id>              查看方案详情
    profile create <name> [options]     创建导出方案
      选项:
        --title-template <tpl>         标题模板 (支持 \${version} 占位)
        --group-order <cats>           分组顺序 (逗号分隔: breaking,feature,fix,other)
        --include-ticket <0|1>         是否带工单号
        --include-author <0|1>         是否带作者
        --include-date <0|1>           是否带日期
        --output-dir <dir>             输出目录
        --force                        同名时覆盖
    profile update <name|id> [options]  更新方案
      选项同 create，另加 --name <newName> 可重命名
    profile delete <name|id>            删除方案
    profile default <name|id>           设为默认方案
    profile duplicate <name|id> [newName]  复制方案
    profile export <name|id> [outputPath]  导出方案为 JSON
    profile import <file|json> [options]  导入方案 JSON
      可选: --name <customName>        导入时重命名
      可选: --force                     同名时覆盖
    profile logs [n]                     查看最近 n 条方案操作日志 (默认 10)
    profile undo                         撤销最近一次方案变更
    profile undo-peek                    查看可撤销的方案操作

  草稿箱管理:
    draft list                           列出所有草稿
    draft show <name|id>                查看草稿详情
    draft create <name> [options]       创建草稿
      选项:
        --version <ver>                目标版本号
        --desc <description>           补充说明
        --force                        同名/同版本时覆盖
    draft update <name|id> [options]    更新草稿
      选项同 create，另加 --name <newName> 可重命名
    draft delete <name|id>              删除草稿
    draft duplicate <name|id> [newName]  复制草稿
      可选: --resolve <cancel|rename|overwrite>  冲突处理策略 (默认 cancel)
    draft apply <name|id>               应用草稿到工作区
    draft archive <name|id>             从草稿一键归档
    draft export <name|id> [outputPath]  导出草稿为 JSON
    draft import <file|json> [options]  导入草稿 JSON
      可选: --name <customName>        导入时重命名
      可选: --force                     同名/同版本时覆盖
    draft compare <id1|name1> <id2|name2>  比较两个草稿的差异
    draft bench <id1|name1> <id2|name2>  审校台: 比较、复制、确认一条链路
      可选: --resolve <cancel|rename|overwrite>  复制冲突处理策略
    draft logs [n]                      查看最近 n 条草稿操作日志 (默认 10)
    draft undo                          撤销最近一次草稿操作
    draft undo-peek                     查看可撤销的草稿操作

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
      } else if (sub === 'backup') {
        const name = args.slice(2).join(' ') || undefined
        try {
          const result = configBackup.exportBackup(name)
          ok(`配置已备份: ${result.filename}`)
          out(`  路径: ${result.path}`)
          out(`  备份ID: ${result.backupId}`)
          out(`  校验和: ${result.checksum}`)
        } catch (e) {
          err(`备份失败: ${e.message}`)
        }
      } else if (sub === 'backup-list') {
        const list = configBackup.listBackups()
        if (list.length === 0) {
          yellow('暂无备份文件')
        } else {
          out(`共有 ${list.length} 个备份:`)
          list.forEach((b, i) => {
            out(`  ${i + 1}. ${b.filename}`)
            out(`     创建: ${b.created} | 大小: ${b.size}B`)
          })
        }
      } else if (sub === 'backup-delete') {
        const filename = args[2]
        if (!filename) { err('用法: config backup-delete <filename>'); break }
        const result = configBackup.deleteBackup(filename)
        if (result.success) {
          ok(`已删除备份: ${filename}`)
        } else {
          err(`删除失败: 备份不存在`)
        }
      } else if (sub === 'diff') {
        const target = args[2]
        if (!target) { err('用法: config diff <filename|path>'); break }
        try {
          const fs = require('fs')
          const pathMod = require('path')
          let diffResult
          let filePath = null
          if (target.includes('/') || target.includes('\\')) {
            filePath = pathMod.isAbsolute(target) ? target : pathMod.resolve(process.cwd(), target)
            if (!fs.existsSync(filePath)) filePath = null
          }
          if (!filePath) {
            const resolved = require('../src/store').readBackupFile(target)
            if (resolved) filePath = resolved.path
          }
          if (!filePath) {
            err(`备份不存在: ${target}`)
            break
          }
          diffResult = configBackup.diffBackupFromFile(filePath)
          if (!diffResult.success) {
            diffResult.errors.forEach(e => err(`  ✗ ${e}`))
            break
          }
          diffResult.validation.info.forEach(i => out(`  ℹ ${i}`))
          diffResult.validation.warnings.forEach(w => yellow(`  ⚠ ${w}`))
          diffResult.validation.errors.forEach(e => err(`  ✗ ${e}`))
          if (!diffResult.valid) {
            err('备份文件结构不合法')
            break
          }
          const dd = diffResult.detailedDiff
          if (!dd.hasChanges) {
            ok('备份内容与当前配置完全一致，无差异')
            break
          }
          out(`\n共 ${dd.changedFields.length} 个字段存在差异:\n`)
          dd.fields.forEach((d, idx) => {
            if (!d.changed) {
              out(`  ${idx + 1}. [一致] ${d.field}`)
            } else {
              yellow(`  ${idx + 1}. [差异] ${d.field}`)
              if (d.isArray) {
                if (d.removed.length > 0) out(`       ← 备份中存在 (将恢复): ${d.removed.join(', ')}`)
                if (d.added.length > 0) out(`       → 当前新增 (将被移除): ${d.added.join(', ')}`)
              } else {
                out(`       ← 备份值: ${JSON.stringify(d.backupValue)}`)
                out(`       → 当前值: ${JSON.stringify(d.currentValue)}`)
              }
            }
          })
          if (diffResult.conflict.hasConflict) {
            yellow(`\n⚠ 冲突提示: 当前配置在备份导出后已被修改，共 ${diffResult.conflict.changes.length} 处变更`)
          }
          out(`\n可恢复字段列表: ${configBackup.SELECTABLE_FIELDS.join(', ')}`)
          out('使用: rn config restore <file> --fields keywords.feature,ignorePatterns 进行按项恢复')
        } catch (e) {
          err(`差异对比失败: ${e.message}`)
        }
      } else if (sub === 'restore') {
        const target = args[2]
        if (!target) { err('用法: config restore <filename|path> [--fields f1,f2,...] [--force] [--dry-run]'); break }
        const forceIdx = args.indexOf('--force')
        const force = forceIdx >= 0
        const dryRunIdx = args.indexOf('--dry-run')
        const dryRun = dryRunIdx >= 0
        const fieldsIdx = args.indexOf('--fields')
        let fields = null
        if (fieldsIdx >= 0 && args[fieldsIdx + 1]) {
          fields = args[fieldsIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
        }
        try {
          const fs = require('fs')
          const pathMod = require('path')
          let result
          const opts = { force, dryRun }
          if (fields) opts.fields = fields
          if (target.includes('/') || target.includes('\\') || target.endsWith('.json')) {
            const absPath = pathMod.isAbsolute(target) ? target : pathMod.resolve(process.cwd(), target)
            if (fs.existsSync(absPath)) {
              result = configBackup.importBackupFromFile(absPath, opts)
            } else {
              result = configBackup.importBackup(target, opts)
            }
          } else {
            result = configBackup.importBackup(target, opts)
          }
          result.logs.forEach(l => out(`  ℹ ${l}`))
          result.warnings.forEach(w => yellow(`  ⚠ ${w}`))
          result.errors.forEach(e => err(`  ✗ ${e}`))
          if (result.success) {
            if (result.skipped) {
              yellow(`恢复已跳过 (${result.reason})`)
            } else if (result.dryRun) {
              yellow('预览模式 (dry-run)，未实际写入')
              if (result.wouldApply && result.wouldApply.length > 0) {
                out(`\n  将应用 ${result.wouldApply.length} 处变更:`)
                result.wouldApply.forEach(c => {
                  out(`    - ${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
                })
              }
            } else {
              ok(result.isPartial ? '按项恢复成功' : '配置恢复成功')
              if (result.selectedFields && result.selectedFields.length > 0) {
                out(`  已应用字段: ${result.selectedFields.join(', ')}`)
              }
              if (result.changes && result.changes.length > 0) {
                out(`  共 ${result.changes.length} 处变更:`)
                result.changes.forEach(c => {
                  out(`    - ${c.field}`)
                })
              }
              out(`  可使用 "rn config undo-restore" 撤销本次恢复`)
            }
          } else {
            err('配置恢复失败')
            process.exit(1)
          }
        } catch (e) {
          err(`恢复失败: ${e.message}`)
        }
      } else if (sub === 'restore-logs') {
        const nStr = args[2]
        const n = nStr ? parseInt(nStr, 10) : 10
        try {
          const logs = configBackup.listRestoreLogs(isNaN(n) ? 10 : n)
          if (logs.length === 0) {
            yellow('暂无恢复操作日志')
          } else {
            out(`最近 ${logs.length} 条恢复操作日志:`)
            logs.forEach((l, i) => {
              const actionLabel = l.action === 'full_restore' ? '整包恢复' : (l.action === 'partial_restore' ? '按项恢复' : '撤销恢复')
              out(`  ${i + 1}. [${actionLabel}] ${l.timestamp}`)
              out(`     来源: ${l.backupName || l.backupId}`)
              if (l.selectedFields && l.selectedFields.length > 0) out(`     字段: ${l.selectedFields.join(', ')}`)
              if (l.changes && l.changes.length > 0) out(`     变更数: ${l.changes.length}`)
            })
          }
        } catch (e) {
          err(`读取日志失败: ${e.message}`)
        }
      } else if (sub === 'restore-peek') {
        const snap = configBackup.peekRestoreUndo()
        if (!snap) {
          yellow('没有可撤销的配置恢复操作')
        } else {
          out(`可撤销的恢复操作:`)
          out(`  来源: ${snap.name} (${snap.backupId})`)
          out(`  恢复时间: ${snap.restoredAt}`)
          if (snap.sourcePath) out(`  文件路径: ${snap.sourcePath}`)
        }
      } else if (sub === 'undo-restore') {
        const result = configBackup.undoLastRestore()
        result.logs.forEach(l => out(`  ℹ ${l}`))
        result.warnings.forEach(w => yellow(`  ⚠ ${w}`))
        result.errors.forEach(e => err(`  ✗ ${e}`))
        if (result.success) {
          ok('已撤销最近一次配置恢复')
        } else {
          err(`撤销失败: ${result.reason || '未知错误'}`)
        }
      } else if (sub === 'validate-file') {
        const filePath = args[2]
        if (!filePath) { err('用法: config validate-file <path>'); break }
        try {
          const fs = require('fs')
          const pathMod = require('path')
          const absPath = pathMod.isAbsolute(filePath) ? filePath : pathMod.resolve(process.cwd(), filePath)
          if (!fs.existsSync(absPath)) {
            err(`文件不存在: ${absPath}`)
            break
          }
          const raw = fs.readFileSync(absPath, 'utf-8')
          const data = JSON.parse(raw)
          const validation = configBackup.validateBackupStructure(data)
          out(`校验结果: ${validation.valid ? '通过' : '失败'}`)
          validation.info.forEach(i => out(`  ℹ ${i}`))
          validation.warnings.forEach(w => yellow(`  ⚠ ${w}`))
          validation.errors.forEach(e => err(`  ✗ ${e}`))
        } catch (e) {
          err(`校验失败: ${e.message}`)
        }
      } else {
        err('未知 config 子命令。使用: show | set | keywords | ignore | reset | backup | backup-list | backup-delete | diff | restore | restore-peek | undo-restore | restore-logs | validate-file')
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
      if (!version) { err('用法: export <version> [outputDir] [--profile name|id] [--profile-id id] [--profile-name name]'); break }
      try {
        const opts = {}
        const pIdx = args.indexOf('--profile')
        const piIdx = args.indexOf('--profile-id')
        const pnIdx = args.indexOf('--profile-name')
        if (pIdx >= 0 && args[pIdx + 1]) {
          const p = args[pIdx + 1]
          const byId = exportProfile.getProfile(p)
          if (byId) opts.profileId = p
          else opts.profileName = p
        }
        if (piIdx >= 0 && args[piIdx + 1]) opts.profileId = args[piIdx + 1]
        if (pnIdx >= 0 && args[pnIdx + 1]) opts.profileName = args[pnIdx + 1]
        const r = exporter.exportToFile(version, outputDir, opts)
        ok(`已导出: ${r.path}`)
        out(`  使用方案: ${r.profileName} (${r.profileId})`)
      } catch (e) {
        err(`导出失败: ${e.message}`)
      }
      break
    }

    case 'export-all': {
      const outputDir = args[1]
      try {
        const opts = {}
        const pIdx = args.indexOf('--profile')
        const piIdx = args.indexOf('--profile-id')
        const pnIdx = args.indexOf('--profile-name')
        if (pIdx >= 0 && args[pIdx + 1]) {
          const p = args[pIdx + 1]
          const byId = exportProfile.getProfile(p)
          if (byId) opts.profileId = p
          else opts.profileName = p
        }
        if (piIdx >= 0 && args[piIdx + 1]) opts.profileId = args[piIdx + 1]
        if (pnIdx >= 0 && args[pnIdx + 1]) opts.profileName = args[pnIdx + 1]
        const files = exporter.exportAll(outputDir, opts)
        if (files.length === 0) {
          yellow('没有可导出的已归档版本')
        } else {
          ok(`已导出 ${files.length} 个文件:`)
          files.forEach(f => {
            out(`  ${f.path}`)
            out(`    方案: ${f.profileName} (${f.profileId})`)
          })
        }
      } catch (e) {
        err(`导出失败: ${e.message}`)
      }
      break
    }

    case 'profile': {
      const sub = args[1]
      if (!sub) { err('用法: profile list|show|create|update|delete|default|duplicate|export|import|logs|undo|undo-peek'); break }

      function resolveProfileIdentifier(arg) {
        const byId = exportProfile.getProfile(arg)
        if (byId) return { id: byId.id, profile: byId }
        const byName = exportProfile.getProfileByName(arg)
        if (byName) return { id: byName.id, profile: byName }
        return null
      }

      function printResultLogs(result) {
        if (result && result.logs) result.logs.forEach(l => out(`  ℹ ${l}`))
        if (result && result.warnings) result.warnings.forEach(w => yellow(`  ⚠ ${w}`))
        if (result && result.errors) result.errors.forEach(e => err(`  ✗ ${e}`))
      }

      function buildProfileFromArgs(argsArr) {
        const p = {}
        const ttIdx = argsArr.indexOf('--title-template')
        const goIdx = argsArr.indexOf('--group-order')
        const itIdx = argsArr.indexOf('--include-ticket')
        const iaIdx = argsArr.indexOf('--include-author')
        const idIdx = argsArr.indexOf('--include-date')
        const odIdx = argsArr.indexOf('--output-dir')
        const nmIdx = argsArr.indexOf('--name')
        if (ttIdx >= 0 && argsArr[ttIdx + 1]) p.titleTemplate = argsArr[ttIdx + 1]
        if (goIdx >= 0 && argsArr[goIdx + 1]) {
          p.groupOrder = argsArr[goIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
        }
        if (itIdx >= 0 && argsArr[itIdx + 1]) p.includeTicket = argsArr[itIdx + 1] === '1' || argsArr[itIdx + 1] === 'true'
        if (iaIdx >= 0 && argsArr[iaIdx + 1]) p.includeAuthor = argsArr[iaIdx + 1] === '1' || argsArr[iaIdx + 1] === 'true'
        if (idIdx >= 0 && argsArr[idIdx + 1]) p.includeDate = argsArr[idIdx + 1] === '1' || argsArr[idIdx + 1] === 'true'
        if (odIdx >= 0 && argsArr[odIdx + 1] !== undefined) p.outputDir = argsArr[odIdx + 1]
        if (nmIdx >= 0 && argsArr[nmIdx + 1]) p.name = argsArr[nmIdx + 1]
        return p
      }

      if (sub === 'list') {
        const list = exportProfile.listProfiles()
        if (list.length === 0) {
          yellow('暂无导出方案')
        } else {
          out(`共有 ${list.length} 个导出方案:`)
          list.forEach((p, i) => {
            const defMark = p.isDefault ? ' [默认]' : ''
            out(`  ${i + 1}. ${p.name}${defMark}`)
            out(`     ID: ${p.id}`)
            out(`     标题模板: ${p.titleTemplate}`)
            out(`     分组顺序: ${p.groupOrder.join(', ')}`)
            out(`     选项: 工单=${p.includeTicket ? '✓' : '✗'} 作者=${p.includeAuthor ? '✓' : '✗'} 日期=${p.includeDate ? '✓' : '✗'}`)
            out(`     输出目录: ${p.outputDir || '(默认)'}`)
            out(`     创建: ${p.createdAt} | 更新: ${p.updatedAt}`)
          })
        }
      } else if (sub === 'show') {
        const ident = args[2]
        if (!ident) { err('用法: profile show <name|id>'); break }
        const resolved = resolveProfileIdentifier(ident)
        if (!resolved) { err(`方案不存在: ${ident}`); break }
        const p = resolved.profile
        const defMark = p.isDefault ? ' [默认]' : ''
        out(`方案: ${p.name}${defMark}`)
        out(`  ID: ${p.id}`)
        out(`  标题模板: ${p.titleTemplate}`)
        out(`  分组顺序: ${p.groupOrder.join(', ')}`)
        out(`  包含工单号: ${p.includeTicket ? '是' : '否'}`)
        out(`  包含作者: ${p.includeAuthor ? '是' : '否'}`)
        out(`  包含日期: ${p.includeDate ? '是' : '否'}`)
        out(`  输出目录: ${p.outputDir || '(默认)'}`)
        out(`  创建时间: ${p.createdAt}`)
        out(`  更新时间: ${p.updatedAt}`)
      } else if (sub === 'create') {
        const name = args[2]
        if (!name) { err('用法: profile create <name> [options]'); break }
        try {
          const input = buildProfileFromArgs(args)
          input.name = name
          const force = args.indexOf('--force') >= 0
          const result = exportProfile.createProfile(input, { force })
          printResultLogs(result)
          if (result.success) {
            if (result.overwritten) {
              yellow(`已覆盖同名方案: ${result.profile.name} (${result.profile.id})`)
            } else {
              ok(`已创建方案: ${result.profile.name} (${result.profile.id})`)
            }
            if (result.profile.isDefault) out('  该方案已被设为默认')
          } else {
            err('创建失败')
            if (result.blocked && result.reason === 'duplicate_name') {
              yellow('提示: 使用 --force 可覆盖同名方案')
            }
          }
        } catch (e) {
          err(`创建失败: ${e.message}`)
        }
      } else if (sub === 'update') {
        const ident = args[2]
        if (!ident) { err('用法: profile update <name|id> [options]'); break }
        const resolved = resolveProfileIdentifier(ident)
        if (!resolved) { err(`方案不存在: ${ident}`); break }
        try {
          const updates = buildProfileFromArgs(args)
          const force = args.indexOf('--force') >= 0
          const result = exportProfile.updateProfile(resolved.id, updates, { force })
          printResultLogs(result)
          if (result.success) {
            ok(`已更新方案: ${result.profile.name} (${result.profile.id})`)
          } else {
            err('更新失败')
            if (result.blocked && result.reason === 'duplicate_name') {
              yellow('提示: 使用 --force 可覆盖同名方案')
            }
          }
        } catch (e) {
          err(`更新失败: ${e.message}`)
        }
      } else if (sub === 'delete') {
        const ident = args[2]
        if (!ident) { err('用法: profile delete <name|id>'); break }
        const resolved = resolveProfileIdentifier(ident)
        if (!resolved) { err(`方案不存在: ${ident}`); break }
        try {
          const result = exportProfile.deleteProfile(resolved.id)
          printResultLogs(result)
          if (result.success) {
            ok(`已删除方案: ${result.deleted.name}`)
            if (result.wasDefault) out('  被删除的方案是默认方案')
            if (result.newDefault) {
              const nd = exportProfile.getProfile(result.newDefault)
              out(`  新的默认方案: ${nd ? nd.name : result.newDefault}`)
            }
          } else {
            err('删除失败')
          }
        } catch (e) {
          err(`删除失败: ${e.message}`)
        }
      } else if (sub === 'default') {
        const ident = args[2]
        if (!ident) { err('用法: profile default <name|id>'); break }
        const resolved = resolveProfileIdentifier(ident)
        if (!resolved) { err(`方案不存在: ${ident}`); break }
        try {
          const result = exportProfile.setDefault(resolved.id)
          printResultLogs(result)
          if (result.success) {
            ok(`已将 "${resolved.profile.name}" 设为默认方案`)
          } else {
            err('设置失败')
          }
        } catch (e) {
          err(`设置失败: ${e.message}`)
        }
      } else if (sub === 'duplicate') {
        const ident = args[2]
        const newName = args[3]
        if (!ident) { err('用法: profile duplicate <name|id> [newName]'); break }
        const resolved = resolveProfileIdentifier(ident)
        if (!resolved) { err(`方案不存在: ${ident}`); break }
        try {
          const result = exportProfile.duplicateProfile(resolved.id, newName)
          printResultLogs(result)
          if (result.success) {
            ok(`已复制方案: ${resolved.profile.name} → ${result.profile.name} (${result.profile.id})`)
          } else {
            err('复制失败')
          }
        } catch (e) {
          err(`复制失败: ${e.message}`)
        }
      } else if (sub === 'export') {
        const ident = args[2]
        const outputPath = args[3]
        if (!ident) { err('用法: profile export <name|id> [outputPath]'); break }
        const resolved = resolveProfileIdentifier(ident)
        if (!resolved) { err(`方案不存在: ${ident}`); break }
        try {
          if (outputPath) {
            const r = exportProfile.exportProfileToFile(resolved.id, outputPath)
            if (r.success) {
              ok(`方案已导出到文件: ${r.path}`)
            } else {
              err(`导出失败: ${(r.errors || []).join('; ')}`)
            }
          } else {
            const r = exportProfile.exportProfileToJson(resolved.id)
            if (r.success) {
              out(JSON.stringify(r.data, null, 2))
            } else {
              err(`导出失败: ${(r.errors || []).join('; ')}`)
            }
          }
        } catch (e) {
          err(`导出失败: ${e.message}`)
        }
      } else if (sub === 'import') {
        const target = args[2]
        if (!target) { err('用法: profile import <file|json> [--name customName] [--force]'); break }
        try {
          const fs = require('fs')
          const pathMod = require('path')
          const nameIdx = args.indexOf('--name')
          const opts = { force: args.indexOf('--force') >= 0 }
          if (nameIdx >= 0 && args[nameIdx + 1]) opts.asName = args[nameIdx + 1]
          let result
          let isFile = false
          if (fs.existsSync(target)) {
            isFile = true
          } else if (target.includes('/') || target.includes('\\') || target.endsWith('.json')) {
            const absPath = pathMod.isAbsolute(target) ? target : pathMod.resolve(process.cwd(), target)
            if (fs.existsSync(absPath)) isFile = true
          }
          if (isFile) {
            const absPath = pathMod.isAbsolute(target) ? target : pathMod.resolve(process.cwd(), target)
            result = exportProfile.importProfileFromFile(absPath, opts)
          } else {
            try {
              const data = JSON.parse(target)
              result = exportProfile.importProfileFromJson(data, opts)
            } catch (parseErr) {
              err(`无法解析输入: 既不是文件路径也不是合法 JSON`)
              break
            }
          }
          printResultLogs(result)
          if (result.success) {
            ok(`已导入方案: ${result.profile.name} (${result.profile.id})`)
          } else {
            err('导入失败')
            if (result.blocked && result.reason === 'duplicate_name') {
              yellow('提示: 使用 --force 可覆盖同名方案，或使用 --name 指定新名称')
            }
          }
        } catch (e) {
          err(`导入失败: ${e.message}`)
        }
      } else if (sub === 'logs') {
        const nStr = args[2]
        const n = nStr ? parseInt(nStr, 10) : 10
        try {
          const logs = exportProfile.listLogs(isNaN(n) ? 10 : n)
          if (logs.length === 0) {
            yellow('暂无方案操作日志')
          } else {
            out(`最近 ${logs.length} 条方案操作日志:`)
            const actionLabels = {
              create: '创建', update: '更新', delete: '删除',
              set_default: '设默认', duplicate: '复制', undo: '撤销'
            }
            logs.forEach((l, i) => {
              const lbl = actionLabels[l.action] || l.action
              out(`  ${i + 1}. [${lbl}] ${l.timestamp}`)
              if (l.profileName) out(`     方案: ${l.profileName} (${l.profileId})`)
              if (l.description) out(`     描述: ${l.description}`)
              if (l.wasDefault) out(`     被删除的是默认方案`)
            })
          }
        } catch (e) {
          err(`读取日志失败: ${e.message}`)
        }
      } else if (sub === 'undo') {
        try {
          const result = exportProfile.undoLastChange()
          printResultLogs(result)
          if (result.success) {
            ok(`已撤销: ${result.description} (操作时间: ${result.timestamp})`)
          } else {
            err(`撤销失败: ${result.reason || '未知错误'}`)
          }
        } catch (e) {
          err(`撤销失败: ${e.message}`)
        }
      } else if (sub === 'undo-peek') {
        const peek = exportProfile.peekUndo()
        if (!peek) {
          yellow('没有可撤销的方案操作')
        } else {
          out(`可撤销: ${peek.description} (${peek.timestamp})`)
        }
      } else {
        err('未知 profile 子命令。使用: list | show | create | update | delete | default | duplicate | export | import | logs | undo | undo-peek')
      }
      break
    }

    case 'draft': {
      const sub = args[1]
      if (!sub) { err('用法: draft list|show|create|update|delete|duplicate|apply|archive|export|import|compare|logs|undo|undo-peek'); break }

      function resolveDraftIdentifier(arg) {
        const byId = draft.getDraft(arg)
        if (byId) return { id: byId.id, draft: byId }
        const byName = draft.getDraftByName(arg)
        if (byName) return { id: byName.id, draft: byName }
        return null
      }

      function printResultLogs(result) {
        if (result && result.logs) result.logs.forEach(l => out(`  ℹ ${l}`))
        if (result && result.warnings) result.warnings.forEach(w => yellow(`  ⚠ ${w}`))
        if (result && result.errors) result.errors.forEach(e => err(`  ✗ ${e}`))
      }

      function buildDraftFromArgs(argsArr) {
        const d = {}
        const vIdx = argsArr.indexOf('--version')
        const descIdx = argsArr.indexOf('--desc')
        const nmIdx = argsArr.indexOf('--name')
        if (vIdx >= 0 && argsArr[vIdx + 1] !== undefined) d.version = argsArr[vIdx + 1]
        if (descIdx >= 0 && argsArr[descIdx + 1] !== undefined) d.description = argsArr[descIdx + 1]
        if (nmIdx >= 0 && argsArr[nmIdx + 1]) d.name = argsArr[nmIdx + 1]
        return d
      }

      if (sub === 'list') {
        const list = draft.listDrafts()
        if (list.length === 0) {
          yellow('暂无草稿')
        } else {
          out(`共有 ${list.length} 个草稿:`)
          list.forEach((d, i) => {
            out(`  ${i + 1}. ${d.name}`)
            out(`     ID: ${d.id}`)
            out(`     版本: ${d.version || '(未设置)'}`)
            out(`     提交数: ${d.commitCount}`)
            out(`     创建: ${d.createdAt} | 更新: ${d.updatedAt}`)
          })
        }
      } else if (sub === 'show') {
        const ident = args[2]
        if (!ident) { err('用法: draft show <name|id>'); break }
        const resolved = resolveDraftIdentifier(ident)
        if (!resolved) { err(`草稿不存在: ${ident}`); break }
        const d = resolved.draft
        out(`草稿: ${d.name}`)
        out(`  ID: ${d.id}`)
        out(`  版本号: ${d.version || '(未设置)'}`)
        out(`  描述: ${d.description || '(无)'}`)
        out(`  提交数: ${d.commits.length}`)
        out(`  创建时间: ${d.createdAt}`)
        out(`  更新时间: ${d.updatedAt}`)
        if (d.exportOptions) {
          out(`  导出方案: ${d.exportOptions.profileName || '(默认)'}`)
        }
        out(`\n  提交分类统计:`)
        const cats = {}
        d.commits.forEach(c => {
          const cat = c.category || 'other'
          cats[cat] = (cats[cat] || 0) + 1
        })
        Object.keys(cats).forEach(cat => {
          out(`    ${cat}: ${cats[cat]} 条`)
        })
      } else if (sub === 'create') {
        const name = args[2]
        if (!name) { err('用法: draft create <name> [options]'); break }
        try {
          const input = buildDraftFromArgs(args)
          input.name = name
          const force = args.indexOf('--force') >= 0
          const result = draft.createDraft({ ...input, force })
          printResultLogs(result)
          if (result.success) {
            if (result.overwritten) {
              yellow(`已覆盖同名草稿: ${result.draft.name} (${result.draft.id})`)
            } else {
              ok(`已创建草稿: ${result.draft.name} (${result.draft.id})`)
            }
            out(`  提交数: ${result.draft.commits.length}`)
          } else {
            err('创建失败')
            if (result.blocked && result.reason === 'duplicate_name') {
              yellow('提示: 使用 --force 可覆盖同名草稿')
            }
            if (result.blocked && result.reason === 'duplicate_version') {
              yellow('提示: 使用 --force 可覆盖同版本草稿')
            }
          }
        } catch (e) {
          err(`创建失败: ${e.message}`)
        }
      } else if (sub === 'update') {
        const ident = args[2]
        if (!ident) { err('用法: draft update <name|id> [options]'); break }
        const resolved = resolveDraftIdentifier(ident)
        if (!resolved) { err(`草稿不存在: ${ident}`); break }
        try {
          const updates = buildDraftFromArgs(args)
          const force = args.indexOf('--force') >= 0
          const result = draft.updateDraft(resolved.id, updates, { force })
          printResultLogs(result)
          if (result.success) {
            ok(`已更新草稿: ${result.draft.name} (${result.draft.id})`)
          } else {
            err('更新失败')
            if (result.blocked && result.reason === 'duplicate_name') {
              yellow('提示: 使用 --force 可覆盖同名草稿')
            }
            if (result.blocked && result.reason === 'duplicate_version') {
              yellow('提示: 使用 --force 可覆盖同版本草稿')
            }
          }
        } catch (e) {
          err(`更新失败: ${e.message}`)
        }
      } else if (sub === 'delete') {
        const ident = args[2]
        if (!ident) { err('用法: draft delete <name|id>'); break }
        const resolved = resolveDraftIdentifier(ident)
        if (!resolved) { err(`草稿不存在: ${ident}`); break }
        try {
          const result = draft.deleteDraft(resolved.id)
          printResultLogs(result)
          if (result.success) {
            ok(`已删除草稿: ${result.deleted.name}`)
          } else {
            err('删除失败')
          }
        } catch (e) {
          err(`删除失败: ${e.message}`)
        }
      } else if (sub === 'duplicate') {
        const ident = args[2]
        const newName = args[3]
        if (!ident) { err('用法: draft duplicate <name|id> [newName] [--resolve cancel|rename|overwrite]'); break }
        const resolved = resolveDraftIdentifier(ident)
        if (!resolved) { err(`草稿不存在: ${ident}`); break }
        try {
          const resolveIdx = args.indexOf('--resolve')
          const resolve = resolveIdx >= 0 && args[resolveIdx + 1] ? args[resolveIdx + 1] : 'cancel'
          if (!['cancel', 'rename', 'overwrite'].includes(resolve)) {
            err('--resolve 只能是 cancel、rename 或 overwrite')
            break
          }
          const result = draft.duplicateDraft(resolved.id, newName, { resolve })
          printResultLogs(result)
          if (result.success) {
            if (result.overwritten) {
              yellow(`已覆盖复制: ${resolved.draft.name} → ${result.draft.name} (${result.draft.id})`)
            } else {
              ok(`已复制草稿: ${resolved.draft.name} → ${result.draft.name} (${result.draft.id})`)
            }
          } else {
            err('复制失败')
            if (result.blocked) {
              if (result.conflictDetails) {
                if (result.conflictDetails.nameConflict) {
                  yellow(`  同名冲突: ${result.conflictDetails.nameConflict.existingName} (${result.conflictDetails.nameConflict.existingId})`)
                }
                if (result.conflictDetails.versionConflict) {
                  yellow(`  同版本冲突: ${result.conflictDetails.versionConflict.existingVersion} (${result.conflictDetails.versionConflict.existingName})`)
                }
              }
              yellow('提示: 使用 --resolve rename 自动改名, 或 --resolve overwrite 覆盖同名草稿')
            }
          }
        } catch (e) {
          err(`复制失败: ${e.message}`)
        }
      } else if (sub === 'apply') {
        const ident = args[2]
        if (!ident) { err('用法: draft apply <name|id>'); break }
        const resolved = resolveDraftIdentifier(ident)
        if (!resolved) { err(`草稿不存在: ${ident}`); break }
        try {
          const result = draft.applyDraft(resolved.id)
          printResultLogs(result)
          if (result.success) {
            ok(`已应用草稿: ${result.draft.name}`)
            out(`  之前提交数: ${result.previousCommitCount}`)
            out(`  应用后提交数: ${result.appliedCommitCount}`)
          } else {
            err('应用失败')
          }
        } catch (e) {
          err(`应用失败: ${e.message}`)
        }
      } else if (sub === 'archive') {
        const ident = args[2]
        if (!ident) { err('用法: draft archive <name|id>'); break }
        const resolved = resolveDraftIdentifier(ident)
        if (!resolved) { err(`草稿不存在: ${ident}`); break }
        try {
          const result = draft.archiveDraft(resolved.id)
          printResultLogs(result)
          if (result.success) {
            ok(`已从草稿归档: ${result.draft.version}`)
            out(`  提交数: ${result.snapshot.commitCount}`)
          } else {
            err('归档失败')
          }
        } catch (e) {
          err(`归档失败: ${e.message}`)
        }
      } else if (sub === 'export') {
        const ident = args[2]
        const outputPath = args[3]
        if (!ident) { err('用法: draft export <name|id> [outputPath]'); break }
        const resolved = resolveDraftIdentifier(ident)
        if (!resolved) { err(`草稿不存在: ${ident}`); break }
        try {
          if (outputPath) {
            const r = draft.exportDraftToFile(resolved.id, outputPath)
            if (r.success) {
              ok(`草稿已导出到文件: ${r.path}`)
            } else {
              err(`导出失败: ${(r.errors || []).join('; ')}`)
            }
          } else {
            const r = draft.exportDraftToJson(resolved.id)
            if (r.success) {
              out(JSON.stringify(r.data, null, 2))
            } else {
              err(`导出失败: ${(r.errors || []).join('; ')}`)
            }
          }
        } catch (e) {
          err(`导出失败: ${e.message}`)
        }
      } else if (sub === 'import') {
        const target = args[2]
        if (!target) { err('用法: draft import <file|json> [--name customName] [--force]'); break }
        try {
          const fs = require('fs')
          const pathMod = require('path')
          const nameIdx = args.indexOf('--name')
          const opts = { force: args.indexOf('--force') >= 0 }
          if (nameIdx >= 0 && args[nameIdx + 1]) opts.asName = args[nameIdx + 1]
          let result
          let isFile = false
          if (fs.existsSync(target)) {
            isFile = true
          } else if (target.includes('/') || target.includes('\\') || target.endsWith('.json')) {
            const absPath = pathMod.isAbsolute(target) ? target : pathMod.resolve(process.cwd(), target)
            if (fs.existsSync(absPath)) isFile = true
          }
          if (isFile) {
            const absPath = pathMod.isAbsolute(target) ? target : pathMod.resolve(process.cwd(), target)
            result = draft.importDraftFromFile(absPath, opts)
          } else {
            try {
              const data = JSON.parse(target)
              result = draft.importDraftFromJson(data, opts)
            } catch (parseErr) {
              err(`无法解析输入: 既不是文件路径也不是合法 JSON`)
              break
            }
          }
          printResultLogs(result)
          if (result.success) {
            ok(`已导入草稿: ${result.draft.name} (${result.draft.id})`)
          } else {
            err('导入失败')
            if (result.blocked && result.reason === 'duplicate_name') {
              yellow('提示: 使用 --force 可覆盖同名草稿，或使用 --name 指定新名称')
            }
            if (result.blocked && result.reason === 'duplicate_version') {
              yellow('提示: 使用 --force 可覆盖同版本草稿')
            }
          }
        } catch (e) {
          err(`导入失败: ${e.message}`)
        }
      } else if (sub === 'compare') {
        const ident1 = args[2]
        const ident2 = args[3]
        if (!ident1 || !ident2) { err('用法: draft compare <id1|name1> <id2|name2>'); break }
        const r1 = resolveDraftIdentifier(ident1)
        const r2 = resolveDraftIdentifier(ident2)
        if (!r1) { err(`草稿不存在: ${ident1}`); break }
        if (!r2) { err(`草稿不存在: ${ident2}`); break }
        try {
          const result = draft.compareDrafts(r1.id, r2.id)
          if (!result.success) {
            err('对比失败')
            result.errors.forEach(e => err(`  ✗ ${e}`))
            break
          }
          const diff = result.diff
          out(`对比: ${r1.draft.name} vs ${r2.draft.name}`)
          out('')
          out(`  名称: ${diff.name.same ? '[一致]' : '[差异]'} ${diff.name.value1} → ${diff.name.value2}`)
          out(`  版本: ${diff.version.same ? '[一致]' : '[差异]'} ${diff.version.value1 || '(空)'} → ${diff.version.value2 || '(空)'}`)
          out(`  描述: ${diff.description.same ? '[一致]' : '[差异]'}`)
          out(`  提交数: ${diff.commitCount.same ? '[一致]' : '[差异]'} ${diff.commitCount.value1} → ${diff.commitCount.value2}`)

          out('')
          out('  导出选项:')
          const eo = diff.exportOptions
          out(`    方案ID: ${eo.profileId.same ? '[一致]' : '[差异]'} ${eo.profileId.value1 || '(空)'} → ${eo.profileId.value2 || '(空)'}`)
          out(`    方案名: ${eo.profileName.same ? '[一致]' : '[差异]'} ${eo.profileName.value1 || '(空)'} → ${eo.profileName.value2 || '(空)'}`)
          out(`    输出目录: ${eo.outputDir.same ? '[一致]' : '[差异]'} ${eo.outputDir.value1 || '(空)'} → ${eo.outputDir.value2 || '(空)'}`)

          if (diff.rules && !diff.rules.same) {
            out('')
            yellow('  规则差异:')
            diff.rules.changes.forEach(ch => {
              out(`    ${ch.field}: ${JSON.stringify(ch.value1)} → ${JSON.stringify(ch.value2)}`)
            })
          }
          out('')
          const c = diff.commits
          if (c.added.length === 0 && c.removed.length === 0 && c.modified.length === 0) {
            ok('  提交内容完全一致')
          } else {
            if (c.added.length > 0) {
              yellow(`  新增提交 (${c.added.length}):`)
              c.added.forEach(cm => out(`    + ${cm.id.substring(0, 8)} ${cm.message}`))
            }
            if (c.removed.length > 0) {
              yellow(`  移除提交 (${c.removed.length}):`)
              c.removed.forEach(cm => out(`    - ${cm.id.substring(0, 8)} ${cm.message}`))
            }
            if (c.modified.length > 0) {
              yellow(`  修改提交 (${c.modified.length}):`)
              c.modified.forEach(cm => {
                out(`    ~ ${cm.id.substring(0, 8)}:`)
                cm.changes.forEach(ch => {
                  out(`       ${ch.field}: ${JSON.stringify(ch.value1)} → ${JSON.stringify(ch.value2)}`)
                })
              })
            }
          }
        } catch (e) {
          err(`对比失败: ${e.message}`)
        }
      } else if (sub === 'logs') {
        const nStr = args[2]
        const n = nStr ? parseInt(nStr, 10) : 10
        try {
          const logs = draft.listLogs(isNaN(n) ? 10 : n)
          if (logs.length === 0) {
            yellow('暂无草稿操作日志')
          } else {
            out(`最近 ${logs.length} 条草稿操作日志:`)
            const actionLabels = {
              create: '创建', update: '更新', delete: '删除',
              duplicate: '复制', apply: '应用', archive: '归档',
              undo: '撤销', import: '导入', export: '导出'
            }
            logs.forEach((l, i) => {
              const lbl = actionLabels[l.action] || l.action
              out(`  ${i + 1}. [${lbl}] ${l.timestamp}`)
              if (l.draftName) out(`     草稿: ${l.draftName} (${l.draftId})`)
              if (l.description) out(`     描述: ${l.description}`)
            })
          }
        } catch (e) {
          err(`读取日志失败: ${e.message}`)
        }
      } else if (sub === 'undo') {
        try {
          const result = draft.undoLastChange()
          printResultLogs(result)
          if (result.success) {
            ok(`已撤销: ${result.description} (操作时间: ${result.timestamp})`)
          } else {
            err(`撤销失败: ${result.reason || '未知错误'}`)
          }
        } catch (e) {
          err(`撤销失败: ${e.message}`)
        }
      } else if (sub === 'undo-peek') {
        const peek = draft.peekUndo()
        if (!peek || !peek.description) {
          yellow('没有可撤销的草稿操作')
        } else {
          out(`可撤销: ${peek.description} (${peek.timestamp})`)
          out(`  撤销栈深度: ${draft.undoStackSize()}`)
        }
      } else if (sub === 'bench') {
        const ident1 = args[2]
        const ident2 = args[3]
        if (!ident1 || !ident2) { err('用法: draft bench <id1|name1> <id2|name2> [--resolve cancel|rename|overwrite]'); break }
        const r1 = resolveDraftIdentifier(ident1)
        const r2 = resolveDraftIdentifier(ident2)
        if (!r1) { err(`草稿不存在: ${ident1}`); break }
        if (!r2) { err(`草稿不存在: ${ident2}`); break }

        ok('\n=== 发布草稿审校台 ===\n')
        out(`草稿 A: ${r1.draft.name} (ID: ${r1.draft.id}, 版本: ${r1.draft.version || '(无)'})`)
        out(`草稿 B: ${r2.draft.name} (ID: ${r2.draft.id}, 版本: ${r2.draft.version || '(无)'})`)
        out('')

        try {
          const result = draft.compareDrafts(r1.id, r2.id)
          if (!result.success) {
            err('对比失败')
            result.errors.forEach(e => err(`  ✗ ${e}`))
            break
          }
          const diff = result.diff

          out('--- 差异比对 ---')
          out(`  名称: ${diff.name.same ? '[一致]' : '[差异]'} ${diff.name.value1} → ${diff.name.value2}`)
          out(`  版本: ${diff.version.same ? '[一致]' : '[差异]'} ${diff.version.value1 || '(空)'} → ${diff.version.value2 || '(空)'}`)
          out(`  描述: ${diff.description.same ? '[一致]' : '[差异]'}`)
          out(`  提交数: ${diff.commitCount.same ? '[一致]' : '[差异]'} ${diff.commitCount.value1} → ${diff.commitCount.value2}`)

          out('  导出选项:')
          const eo = diff.exportOptions
          out(`    方案ID: ${eo.profileId.same ? '[一致]' : '[差异]'} ${eo.profileId.value1 || '(空)'} → ${eo.profileId.value2 || '(空)'}`)
          out(`    方案名: ${eo.profileName.same ? '[一致]' : '[差异]'} ${eo.profileName.value1 || '(空)'} → ${eo.profileName.value2 || '(空)'}`)
          out(`    输出目录: ${eo.outputDir.same ? '[一致]' : '[差异]'} ${eo.outputDir.value1 || '(空)'} → ${eo.outputDir.value2 || '(空)'}`)

          if (diff.rules && !diff.rules.same) {
            yellow('  规则差异:')
            diff.rules.changes.forEach(ch => {
              out(`    ${ch.field}: ${JSON.stringify(ch.value1)} → ${JSON.stringify(ch.value2)}`)
            })
          }

          out('')
          const c = diff.commits
          if (c.added.length === 0 && c.removed.length === 0 && c.modified.length === 0) {
            ok('  提交内容完全一致')
          } else {
            if (c.added.length > 0) {
              yellow(`  B 新增提交 (${c.added.length}):`)
              c.added.forEach(cm => out(`    + ${cm.id.substring(0, 8)} ${cm.message}`))
            }
            if (c.removed.length > 0) {
              yellow(`  A 独有提交 (${c.removed.length}):`)
              c.removed.forEach(cm => out(`    - ${cm.id.substring(0, 8)} ${cm.message}`))
            }
            if (c.modified.length > 0) {
              yellow(`  修改提交 (${c.modified.length}):`)
              c.modified.forEach(cm => {
                out(`    ~ ${cm.id.substring(0, 8)}:`)
                cm.changes.forEach(ch => {
                  out(`       ${ch.field}: ${JSON.stringify(ch.value1)} → ${JSON.stringify(ch.value2)}`)
                })
              })
            }
          }

          out('')
          out('--- 复制操作 ---')
          const resolveIdx = args.indexOf('--resolve')
          const resolve = resolveIdx >= 0 && args[resolveIdx + 1] ? args[resolveIdx + 1] : 'cancel'
          if (!['cancel', 'rename', 'overwrite'].includes(resolve)) {
            err('--resolve 只能是 cancel、rename 或 overwrite')
            break
          }
          out(`  冲突策略: ${resolve}`)
          const dupResult = draft.duplicateDraft(r1.id, `${r1.draft.name} (审校副本)`, { resolve })
          if (dupResult.success) {
            if (dupResult.overwritten) {
              yellow(`  已覆盖复制: ${r1.draft.name} → ${dupResult.draft.name} (${dupResult.draft.id})`)
            } else {
              ok(`  已复制: ${r1.draft.name} → ${dupResult.draft.name} (${dupResult.draft.id})`)
            }
          } else {
            if (dupResult.blocked) {
              yellow('  复制被冲突阻止:')
              dupResult.errors.forEach(e => yellow(`    ⚠ ${e}`))
              out('  提示: 使用 --resolve rename 或 --resolve overwrite 解决冲突')
            } else {
              err('  复制失败:')
              dupResult.errors.forEach(e => err(`    ✗ ${e}`))
            }
          }

          out('')
          ok('--- 审校完成 ---')
          out(`  撤销栈深度: ${draft.undoStackSize()}`)
          out('  使用 "rn draft undo" 可撤销最近操作')
        } catch (e) {
          err(`审校失败: ${e.message}`)
        }
      } else {
        err('未知 draft 子命令。使用: list | show | create | update | delete | duplicate | apply | archive | export | import | compare | bench | logs | undo | undo-peek')
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
