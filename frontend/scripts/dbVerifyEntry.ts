/* eslint-disable no-console */
import assert from 'node:assert/strict'
import type { Artifact, Relation, Stratum } from '@/types'
import { db } from '@/hooks/usePersistentStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { MergeConflictError } from '@/utils/stratumMerge'

const S = (id: string, code: string, topDepth: number, bottomDepth: number): Stratum => ({
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
  drawingNo: ''
})
const AF = (id: string, stratumId: string, z: number): Artifact => ({
  id,
  stratumId,
  code: id,
  category: '陶器',
  count: 1,
  completeness: '残片',
  x: 0,
  y: 0,
  z,
  date: '',
  collector: '',
  tempLocation: ''
})
const RL = (id: string, unitAId: string, type: Relation['type'], unitBId: string): Relation => ({
  id,
  unitAId,
  type,
  unitBId,
  basis: '剖面观察',
  recorder: '',
  note: ''
})

async function resetDb(): Promise<void> {
  await db.delete()
  await db.open()
}

export default async function run(assertLib: typeof assert): Promise<number> {
  let passed = 0
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  }

  // 1. 成功合并：器物转移、越界标记落库、曾用号落库、源单位删除
  await check('成功合并后数据落库（曾用号/越界标记/关系改写）', async () => {
    await resetDb()
    await db.strata.bulkPut([S('k', 'H1', 0.5, 1.0), S('d', 'H9', 0.5, 0.8), S('o', 'O1', 1.0, 1.3)])
    await db.artifacts.bulkPut([AF('a1', 'd', 0.6), AF('a2', 'd', 1.2)])
    await db.relations.bulkPut([RL('r1', 'd', '叠压', 'o')])

    await Promise.all([stratumStore.getState().hydrate(), artifactStore.getState().hydrate(), relationStore.getState().hydrate()])
    const plan = await stratumStore.getState().mergeUnits('k', ['d'])
    assertLib.equal(plan.movingArtifacts.length, 2)
    assertLib.equal(plan.outOfRangeArtifacts.length, 1)

    // 直接读库验证持久化
    const keep = await db.strata.get('k')
    assertLib.deepEqual(keep?.formerCodes, ['H9'])
    assertLib.equal(await db.strata.get('d'), undefined)

    const a1 = await db.artifacts.get('a1')
    const a2 = await db.artifacts.get('a2')
    assertLib.equal(a1?.stratumId, 'k')
    assertLib.equal(a1?.depthOutOfRange, false)
    assertLib.equal(a2?.stratumId, 'k')
    assertLib.equal(a2?.depthOutOfRange, true)

    const r1 = await db.relations.get('r1')
    assertLib.equal(r1?.unitAId, 'k')
    assertLib.equal(r1?.unitBId, 'o')
  })

  // 2. 冲突时不写任何数据
  await check('自关联冲突：两个单位与全部器物/关系原样保留', async () => {
    await resetDb()
    await db.strata.bulkPut([S('k', 'K', 0.2, 0.6), S('d', 'D', 0.6, 0.9)])
    await db.artifacts.bulkPut([AF('a1', 'd', 0.7)])
    await db.relations.bulkPut([RL('r1', 'd', '叠压', 'k')])

    await Promise.all([stratumStore.getState().hydrate(), artifactStore.getState().hydrate(), relationStore.getState().hydrate()])
    await assertLib.rejects(() => stratumStore.getState().mergeUnits('k', ['d']), MergeConflictError)

    assertLib.ok(await db.strata.get('d'), '源单位仍在')
    assertLib.ok(await db.strata.get('k'), '保留单位仍在')
    const a1 = await db.artifacts.get('a1')
    assertLib.equal(a1?.stratumId, 'd', '器物未被转走')
    const r1 = await db.relations.get('r1')
    assertLib.equal(r1?.unitAId, 'd', '关系未被改写')
    const keep = await db.strata.get('k')
    assertLib.deepEqual(keep?.formerCodes ?? [], [])
  })

  // 3. 事务中途失败整体回滚（在事务执行中人为抛错）
  await check('写入中途失败：事务回滚，两份记录原样保留', async () => {
    await resetDb()
    await db.strata.bulkPut([S('k', 'K', 0.2, 0.6), S('d', 'D', 0.6, 0.9)])
    await db.artifacts.bulkPut([AF('a1', 'd', 0.7)])

    await Promise.all([stratumStore.getState().hydrate(), artifactStore.getState().hydrate(), relationStore.getState().hydrate()])

    // 拦截 bulkPut：器物表第一次 bulkPut 时抛错（模拟写入中途失败）
    const originalBulkPut = db.artifacts.bulkPut.bind(db.artifacts)
    let call = 0
    db.artifacts.bulkPut = ((...args: unknown[]) => {
      call += 1
      if (call === 1) throw new Error('模拟 IndexedDB 写入失败')
      return originalBulkPut(...(args as Parameters<typeof originalBulkPut>))
    }) as typeof db.artifacts.bulkPut

    await assertLib.rejects(
      () => stratumStore.getState().mergeUnits('k', ['d']),
      /模拟 IndexedDB 写入失败/
    )
    db.artifacts.bulkPut = originalBulkPut

    assertLib.ok(await db.strata.get('d'), '回滚：源单位仍在')
    const a1 = await db.artifacts.get('a1')
    assertLib.equal(a1?.stratumId, 'd', '回滚：器物未转走')
    assertLib.equal(a1?.depthOutOfRange, undefined, '回滚：越界标记未写入')
    const keep = await db.strata.get('k')
    assertLib.deepEqual(keep?.formerCodes ?? [], [], '回滚：曾用号未写入')
    // store 内存也已按磁盘重新对齐
    assertLib.ok(stratumStore.getState().strata.some((item) => item.id === 'd'))
    assertLib.equal(artifactStore.getState().artifacts.find((item) => item.id === 'a1')?.stratumId, 'd')
  })

  // 4. 合并结果"重开页面"仍可见：重新 hydrate（模拟刷新）
  await check('重新 hydrate（模拟重开页面）后合并结果仍在', async () => {
    await resetDb()
    await db.strata.bulkPut([S('k', 'H1', 0.5, 1.0), S('d', 'H9', 0.5, 0.8)])
    await db.artifacts.bulkPut([AF('a1', 'd', 0.6)])
    await stratumStore.getState().hydrate()
    await artifactStore.getState().hydrate()
    await relationStore.getState().hydrate()
    await stratumStore.getState().mergeUnits('k', ['d'])

    // 模拟页面重开：store 清空后重新 hydrate
    await Promise.all([stratumStore.getState().hydrate(), artifactStore.getState().hydrate()])
    const strata = stratumStore.getState().strata
    assertLib.equal(strata.length, 1)
    assertLib.deepEqual(strata[0].formerCodes, ['H9'])
    const artifacts = artifactStore.getState().artifacts
    assertLib.equal(artifacts[0].stratumId, 'k')
  })

  await db.close()
  return passed
}
