// IndexedDB 层端到端验证：冲突不写入、中途失败整体回滚、合并结果持久可见
import 'fake-indexeddb/auto'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const out = join(tmpdir(), 'merge-db-verify.mjs')
await build({
  entryPoints: ['scripts/dbVerifyEntry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'silent',
  alias: { '@': join(process.cwd(), 'src') }
})

const mod = await import(pathToFileURL(out).href)
const failures = await mod.default(assert)
console.log(`\n全部 ${failures} 项 IndexedDB 合并验证通过`)
