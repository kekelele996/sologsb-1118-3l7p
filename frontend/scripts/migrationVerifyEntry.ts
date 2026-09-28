/* eslint-disable no-console */
import assert from 'node:assert/strict'
import Dexie, { type Table } from 'dexie'
import type { Artifact, Relation, Stratum, Trench } from '@/types'

/** 按 v2 结构建库并写入历史数据，再升级到当前版本，验证迁移补齐字段 */
class OldDb extends Dexie {
  trenches!: Table<Trench, string>
  strata!: Table<Stratum, string>
  artifacts!: Table<Artifact, string>
  relations!: Table<Relation, string>
  meta!: Table<{ key: string; value: number }, string>

  constructor() {
    super('gbtrenchlog')
    this.version(1).stores({
      trenches: 'id, code, area',
      strata: 'id, trenchId, code, type',
      artifacts: 'id, stratumId, code, category',
      relations: 'id, unitAId, unitBId, type',
      meta: 'key'
    })
    this.version(2).stores({
      trenches: 'id, code, area, backfilled',
      strata: 'id, trenchId, code, type, topDepth',
      artifacts: 'id, stratumId, code, category, date',
      relations: 'id, unitAId, unitBId, type, basis',
      meta: 'key'
    })
  }
}

export default async function run(assertLib: typeof assert): Promise<number> {
  const old = new OldDb()
  await old.table('strata').put({
    id: 's1',
    trenchId: 't1',
    code: 'H1',
    type: '灰坑',
    openLayer: '第②层下',
    topDepth: 0.5,
    bottomDepth: 1.2,
    soil: '灰土',
    inclusions: ['陶片'],
    formation: '',
    date: '2024-01-01',
    drawingNo: ''
  } as unknown as Stratum)
  await old.table('artifacts').put({
    id: 'a1',
    stratumId: 's1',
    code: 'X:1',
    category: '陶器',
    count: 1,
    completeness: '残片',
    x: 1,
    y: 1,
    z: 0.8,
    date: '2024-01-01',
    collector: '',
    tempLocation: ''
  } as unknown as Artifact)
  await old.close()

  // 动态导入当前 db（同库名，会触发 v2 → v3 升级）
  const { db } = await import('@/hooks/usePersistentStore')
  const stratum = await db.strata.get('s1')
  assertLib.ok(stratum)
  assertLib.deepEqual(stratum?.formerCodes, [], '迁移补齐 formerCodes 空数组')
  const artifact = await db.artifacts.get('a1')
  assertLib.equal(artifact?.depthOutOfRange, false, '迁移补齐 depthOutOfRange=false')

  await db.delete()
  console.log('  ✓ v2 → v3 升级为历史数据补齐 formerCodes / depthOutOfRange')
  return 1
}
