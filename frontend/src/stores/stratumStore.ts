import { createStore } from 'zustand/vanilla'
import type { Stratum, UnitType } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { planMergeStrata, type MergePlan } from '@/utils/merge'

/** 预检冲突（自关联 / 闭合环路 / 非同探方）：携带可展示的冲突说明 */
export class MergeConflictError extends Error {
  conflicts: string[]
  constructor(conflicts: string[]) {
    super(conflicts[0] ?? '合并预检未通过')
    this.name = 'MergeConflictError'
    this.conflicts = conflicts
  }
}

export interface StratumState {
  strata: Stratum[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (stratum: Stratum) => Promise<void>
  remove: (id: string) => Promise<void>
  bulkSetType: (ids: string[], type: UnitType) => Promise<void>
  /**
   * 合并地层单位：把 sourceId 并入 targetId（仅允许同一探方）。
   * 全部读写在同一个 IndexedDB 事务内：预检冲突或写入中途失败都会回滚，
   * 保留单位与待并入单位两份记录原样保留。成功后返回预检明细。
   */
  mergeUnits: (targetId: string, sourceId: string) => Promise<MergePlan>
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
    await syncDelete<Stratum>(db.strata, id)
    await get().hydrate()
  },
  bulkSetType: async (ids, type) => {
    const targets = get().strata.filter((item) => ids.includes(item.id))
    await Promise.all(targets.map((item) => syncPut<Stratum>(db.strata, { ...item, type })))
    await get().hydrate()
  },
  mergeUnits: async (targetId, sourceId) => {
    if (targetId === sourceId) {
      throw new MergeConflictError(['保留单位与待并入单位不能是同一个'])
    }

    // 单事务：预检 + 全部写入。任何一步失败 IndexedDB 自动回滚，不留下半合并数据
    const plan = await db.transaction('rw', db.strata, db.artifacts, db.relations, async () => {
      const [strata, artifacts, relations] = await Promise.all([
        db.strata.toArray(),
        db.artifacts.toArray(),
        db.relations.toArray()
      ])
      const target = strata.find((item) => item.id === targetId)
      const source = strata.find((item) => item.id === sourceId)
      if (!target || !source) {
        throw new MergeConflictError(['保留单位或待并入单位不存在，请刷新后重试'])
      }
      if (target.trenchId !== source.trenchId) {
        throw new MergeConflictError([`只能合并同一探方内的单位：${target.code} 与 ${source.code} 分属不同探方`])
      }

      const result = planMergeStrata({ strata, artifacts, relations, targetId, sourceId })
      if (result.conflicts.length > 0) {
        throw new MergeConflictError(result.conflicts)
      }

      // 旧单位号（含其历史曾用号）作为曾用号留在保留单位上
      const usedCodes = new Set((target.formerCodes ?? []).map((code) => code.trim().toUpperCase()))
      usedCodes.add(target.code.trim().toUpperCase())
      const formerCodes = [...(target.formerCodes ?? [])]
      for (const code of [source.code, ...(source.formerCodes ?? [])]) {
        const key = code.trim().toUpperCase()
        if (!usedCodes.has(key)) {
          usedCodes.add(key)
          formerCodes.push(code)
        }
      }

      await db.strata.put({ ...target, formerCodes })
      await Promise.all(result.artifacts.map((item) => db.artifacts.put(item.updated)))
      await Promise.all(result.rewrittenRelations.map((item) => db.relations.put(item.updated)))
      await Promise.all(result.duplicateRelations.map((item) => db.relations.delete(item.id)))
      await db.strata.delete(sourceId)

      return result
    })

    await Promise.all([get().hydrate(), artifactStore.getState().hydrate(), relationStore.getState().hydrate()])
    return plan
  }
}))
