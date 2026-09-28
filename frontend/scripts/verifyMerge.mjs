// 合并引擎场景验证：esbuild 即时打包纯 TS 后用 node 运行
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const out = join(tmpdir(), 'merge-verify.mjs')
await build({
  entryPoints: ['src/utils/stratumMerge.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'silent',
  alias: { '@': join(process.cwd(), 'src') }
})

const { planStratumMerge, MergeConflictError, MergeValidationError } = await import(pathToFileURL(out).href)

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const S = (id, code, topDepth, bottomDepth, extra = {}) => ({
  id,
  trenchId: 't1',
  code,
  type: '地层',
  openLayer: '',
  topDepth,
  bottomDepth,
  soil: '',
  inclusions: [],
  formation: '',
  date: '',
  drawingNo: '',
  formerCodes: [],
  ...extra
})
const A = (id, stratumId, z, count = 1) => ({
  id,
  stratumId,
  code: id,
  category: '陶器',
  count,
  completeness: '残片',
  x: 0,
  y: 0,
  z,
  date: '',
  collector: '',
  tempLocation: ''
})
const R = (id, unitAId, type, unitBId) => ({ id, unitAId, type, unitBId, basis: '剖面观察', recorder: '', note: '' })

// 场景 1：基本合并——器物转移 + 深度越界统计 + 曾用号
check('器物转移计数、越界标出、曾用号留存', () => {
  const keep = S('k', 'H1', 0.5, 1.0)
  const dup = S('d', 'H1', 0.5, 0.8)
  const plan = planStratumMerge({
    keepId: 'k',
    sourceIds: ['d'],
    strata: [keep, dup],
    artifacts: [A('a1', 'd', 0.6), A('a2', 'd', 0.9, 3), A('a3', 'd', 1.2)],
    relations: []
  })
  assert.equal(plan.conflicts.length, 0)
  assert.equal(plan.movingArtifacts.length, 3)
  assert.equal(plan.movingArtifacts.reduce((s, i) => s + i.count, 0), 5)
  assert.deepEqual(plan.outOfRangeArtifacts.map((i) => i.id), ['a3'])
  // 重复单位号与保留单位同名时不作为曾用号（现号即该号，列出"曾用 H1"反而误导）
  assert.deepEqual(plan.mergedFormerCodes, [])
})

// 场景 1b：异号并入时旧号成为曾用号
check('异号并入时旧单位号成为曾用号', () => {
  const keep = S('k', 'H1', 0.5, 1.0)
  const dup = S('d', 'H9', 0.5, 0.8)
  const plan = planStratumMerge({
    keepId: 'k',
    sourceIds: ['d'],
    strata: [keep, dup],
    artifacts: [A('a1', 'd', 0.6)],
    relations: []
  })
  assert.deepEqual(plan.mergedFormerCodes, ['H9'])
})

// 场景 2：关系改写 + 与保留单位既有关系重复去重
check('关系端点改写、重复关系去重删除（计数正确）', () => {
  const keep = S('k', 'K', 0.2, 0.5)
  const dup = S('d', 'D', 0.5, 0.8)
  const other = S('o', 'O', 0.8, 1.2)
  const relations = [
    R('r1', 'd', '叠压', 'o'), // 改写为 k 叠压 o
    R('r2', 'k', '叠压', 'o'), // 既有同关系 → r1 去重删除
    R('r3', 'd', '打破', 'o') // 改写为 k 打破 o（不构成环）
  ]
  const plan = planStratumMerge({ keepId: 'k', sourceIds: ['d'], strata: [keep, dup, other], artifacts: [], relations })
  assert.equal(plan.conflicts.length, 0)
  // r1 与既有 r2 重复 → 去重删除（保留 r2 原样）；r3 端点改写
  assert.equal(plan.finalRelations.length, 1)
  assert.deepEqual(
    plan.finalRelations.map((p) => [p.relation.id, p.relation.unitAId, p.relation.unitBId]),
    [['r3', 'k', 'o']]
  )
  assert.equal(plan.duplicateRelations.length, 1)
  assert.equal(plan.duplicateRelations[0].relation.id, 'r1')
})

// 场景 3：去重后自关联 → 冲突，禁止合并
check('去重后自关联判为冲突', () => {
  const keep = S('k', 'K', 0.2, 0.6)
  const dup = S('d', 'D', 0.6, 0.9)
  const relations = [R('r1', 'd', '叠压', 'k')] // 合并后 k 叠压 k
  const plan = planStratumMerge({ keepId: 'k', sourceIds: ['d'], strata: [keep, dup], artifacts: [], relations })
  assert.ok(plan.selfRelations.length >= 1)
  assert.ok(plan.conflicts.some((c) => c.includes('自关联')))
})

// 场景 4：闭合矛盾（环路）→ 冲突
check('改写后形成闭合环路判为冲突', () => {
  const keep = S('k', 'K', 0.2, 0.4)
  const dup = S('d', 'D', 0.4, 0.6)
  const x = S('x', 'X', 0.6, 0.9)
  const relations = [
    R('r1', 'k', '叠压', 'x'), // k → x
    R('r2', 'x', '叠压', 'd') // x → 合并后为 k，形成 k→x→k
  ]
  const plan = planStratumMerge({ keepId: 'k', sourceIds: ['d'], strata: [keep, dup, x], artifacts: [], relations })
  assert.ok(plan.cycleCodes.length > 0)
  assert.ok(plan.conflicts.some((c) => c.includes('闭合矛盾')))
})

// 场景 5：共存关系按无向去重
check('共存关系无向语义去重', () => {
  const keep = S('k', 'K', 0.2, 0.5)
  const dup = S('d', 'D', 0.5, 0.7)
  const o1 = S('o1', 'O1', 0.7, 0.85)
  const o2 = S('o2', 'O2', 0.85, 1.0)
  const relations = [
    R('r1', 'o1', '共存', 'o2'), // 既有 o1 共存 o2
    R('r2', 'd', '共存', 'o2'),
    R('r3', 'o2', '共存', 'o1') // 与 r1 无向重复（与本次合并无关，不应被动）
  ]
  // 注意：r3 与 r1 是数据里既有的重复，预检只处理被并入单位相关关系，r3 原样保留
  const plan = planStratumMerge({ keepId: 'k', sourceIds: ['d'], strata: [keep, dup, o1, o2], artifacts: [], relations })
  // r2 改写为 k 共存 o2，与任何既有关系不重复 → 保留
  assert.equal(plan.finalRelations.length, 1)
  assert.equal(plan.finalRelations[0].relation.id, 'r2')
  assert.equal(plan.duplicateRelations.length, 0)

  // 真正的无向去重：r2 改写后与保留单位既有的 k 共存 o2 撞键
  const plan2 = planStratumMerge({
    keepId: 'k',
    sourceIds: ['d'],
    strata: [keep, dup, o2],
    artifacts: [],
    relations: [R('r4', 'o2', '共存', 'k'), R('r5', 'd', '共存', 'o2')]
  })
  assert.equal(plan2.finalRelations.length, 0)
  assert.equal(plan2.duplicateRelations.length, 1)
  assert.equal(plan2.duplicateRelations[0].relation.id, 'r5')
})

// 场景 6：跨探方拒绝；保留单位与待并入相同/为空拒绝
check('跨探方合并被拒绝', () => {
  const keep = S('k', 'K', 0.2, 0.5)
  const otherTrench = S('x', 'X', 0.5, 0.7, { trenchId: 't2' })
  assert.throws(
    () => planStratumMerge({ keepId: 'k', sourceIds: ['x'], strata: [keep, otherTrench], artifacts: [], relations: [] }),
    MergeValidationError
  )
})

// 场景 7：二次合并——曾用号串联（旧单位自身曾用号一并带到保留单位）
check('二次合并曾用号串联且去重', () => {
  const keep = S('k', 'K', 0.2, 1.0)
  const mid = S('m', 'M', 0.2, 1.0, { formerCodes: ['OLD'] })
  const plan = planStratumMerge({ keepId: 'k', sourceIds: ['m'], strata: [keep, mid], artifacts: [], relations: [] })
  assert.deepEqual(plan.mergedFormerCodes, ['M', 'OLD'])
})

// 场景 8：多源合并 + 源间关系去重后产生自关联
check('多源合并：两个被并入单位之间的关系变成自关联', () => {
  const keep = S('k', 'K', 0.2, 1.0)
  const d1 = S('d1', 'D1', 0.2, 0.5)
  const d2 = S('d2', 'D2', 0.5, 1.0)
  const relations = [R('r1', 'd1', '叠压', 'd2')]
  const plan = planStratumMerge({ keepId: 'k', sourceIds: ['d1', 'd2'], strata: [keep, d1, d2], artifacts: [], relations })
  assert.ok(plan.conflicts.some((c) => c.includes('自关联')))
})

// 场景 9：与保留单位无关的既有关系绝不被去重/改写
check('未受影响的关系原样保留、不参与去重', () => {
  const keep = S('k', 'K', 0.2, 0.4)
  const dup = S('d', 'D', 0.4, 0.6)
  const o1 = S('o1', 'O1', 0.6, 0.8)
  const o2 = S('o2', 'O2', 0.8, 1.0)
  const relations = [
    R('r0', 'o1', '叠压', 'o2'), // 与合并完全无关
    R('r1', 'd', '叠压', 'o1')
  ]
  const plan = planStratumMerge({ keepId: 'k', sourceIds: ['d'], strata: [keep, dup, o1, o2], artifacts: [], relations })
  assert.equal(plan.finalRelations.length, 1)
  assert.equal(plan.finalRelations[0].relation.id, 'r1')
  assert.equal(plan.duplicateRelations.length, 0)
})

console.log(`\n全部 ${passed} 项合并引擎验证通过`)
