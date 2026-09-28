// v2 → v3 schema 迁移验证
import 'fake-indexeddb/auto'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const out = join(tmpdir(), 'merge-migration-verify.mjs')
await build({
  entryPoints: ['scripts/migrationVerifyEntry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'silent',
  alias: { '@': join(process.cwd(), 'src') }
})

const mod = await import(pathToFileURL(out).href)
const count = await mod.default(assert)
console.log(`\n${count} 项迁移验证通过`)
