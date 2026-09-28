import { createStore } from 'zustand/vanilla'
import type { Relation, Stratum, UnitType } from '@/types'
import { db, syncAll, syncPut } from '@/hooks/usePersistentStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { MergeConflictError, planStratumMerge, type MergePlan } from '@/utils/stratumMerge'

export interface StratumState {
  strata: Stratum[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (stratum: Stratum) => Promise<void>
  remove: (id: string) => Promise<void>
  bulkSetType: (ids: string[], type: UnitType) => Promise<void>
  /**
   * 合并地层单位：预检（器物转移计数、关系改写/去重、自关联与闭合矛盾）通过后，
   * 在单个 Dexie 事务内写入三张表；预检有冲突抛 MergeConflictError，
   * 写入中途失败事务整体回滚——两种情况下两份记录都原样保留。
   */
  mergeUnits: (keepId: string, sourceIds: string[]) => Promise<MergePlan>
}

/** 从各表读取最新数据后重新填充三个 store（合并提交或失败回滚后都要对齐内存） */
async function rehydrateAll(): Promise<void> {
  await Promise.all([
    stratumStore.getState().hydrate(),
    artifactStore.getState().hydrate(),
    relationStore.getState().hydrate()
  ])
}

export const stratumStore = createStore<StratumState>((set, get) => ({
  strata: [],
  loaded: false,
  hydrate: async () => {
    const strata = await syncAll<Stratum>(db.strata)
    strata.sort((a, b) => (a.topDepth === b.topDepth ? a.code.localeCompare(b.code, 'zh-Hans-CN') : a.topDepth - b.topDepth))
    set({ strata, loaded: true })
  },
  save: async (stratum) => {
    await syncPut<Stratum>(db.strata, stratum)
    await get().hydrate()
  },
  remove: async (id) => {
    await db.strata.delete(id)
    await get().hydrate()
  },
  bulkSetType: async (ids, type) => {
    const targets = get().strata.filter((item) => ids.includes(item.id))
    await Promise.all(targets.map((item) => syncPut<Stratum>(db.strata, { ...item, type })))
    await get().hydrate()
  },
  mergeUnits: async (keepId, sourceIds) => {
    const current = {
      strata: get().strata,
      artifacts: artifactStore.getState().artifacts,
      relations: relationStore.getState().relations
    }
    // 预检：冲突直接抛出，不开启任何写入
    const preview = planStratumMerge({ keepId, sourceIds, ...current })
    if (preview.conflicts.length > 0) {
      throw new MergeConflictError(preview.conflicts)
    }

    const sourceSet = new Set(preview.sources.map((item) => item.id))
    let committed: MergePlan = preview

    try {
      // 三张表同一事务：任何一步失败，IndexedDB 自动回滚全部已执行写操作
      await db.transaction('rw', db.strata, db.artifacts, db.relations, async () => {
        // 事务内重新读取，避免与预检之间有其他写入造成偏差
        const [dbStrata, dbArtifacts, dbRelations] = await Promise.all([
          db.strata.toArray(),
          db.artifacts.toArray(),
          db.relations.toArray()
        ])
        const fresh = planStratumMerge({
          keepId,
          sourceIds: [...sourceSet],
          strata: dbStrata,
          artifacts: dbArtifacts,
          relations: dbRelations
        })
        if (fresh.conflicts.length > 0) {
          throw new MergeConflictError(fresh.conflicts)
        }

        const moved = new Map(fresh.movingArtifacts.map((item) => [item.id, true]))
        const outOfRange = new Set(fresh.outOfRangeArtifacts.map((item) => item.id))
        await db.artifacts.bulkPut(
          dbArtifacts
            .filter((item) => moved.has(item.id))
            .map((artifact) => ({
              ...artifact,
              stratumId: keepId,
              depthOutOfRange: outOfRange.has(artifact.id)
            }))
        )

        const rewriteById = new Map(fresh.finalRelations.map((item) => [item.relation.id, item.relation]))
        await db.relations.bulkPut(
          dbRelations
            .filter((item) => rewriteById.has(item.id))
            .map((item) => rewriteById.get(item.id) as Relation)
        )
        await db.relations.bulkDelete(fresh.duplicateRelations.map((item) => item.relation.id))

        await db.strata.put({ ...fresh.keep, formerCodes: fresh.mergedFormerCodes })
        await db.strata.bulkDelete([...sourceSet])
        committed = fresh
      })
    } catch (error) {
      // 事务已回滚：以磁盘真实数据刷新内存，确保两份记录原样可见
      await rehydrateAll()
      throw error
    }

    await rehydrateAll()
    return committed
  }
}))
