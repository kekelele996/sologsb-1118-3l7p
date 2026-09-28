import type { Artifact, Relation, Stratum } from '@/types'
import { isArtifactDepthOutOfRange } from '@/types'
import { buildGraph } from '@/utils/graph'

/** 合并预检入参 */
export interface MergeInput {
  /** 保留单位 id */
  keepId: string
  /** 待并入单位 id 列表（可一次并入多个重复单位） */
  sourceIds: string[]
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
}

/** 改写后的关系计划 */
export interface MergedRelationPlan {
  relation: Relation
  /** 改写前关系涉及的单位号文案（冲突说明用） */
  fromText: string
}

/** 合并预检结果（无冲突时才允许执行） */
export interface MergePlan {
  keep: Stratum
  sources: Stratum[]
  /** 将转到保留单位的器物 */
  movingArtifacts: Artifact[]
  /** 转移后深度超出保留单位区间的器物 */
  outOfRangeArtifacts: Artifact[]
  /** 去重后保留下来的关系（端点已改写为保留单位） */
  finalRelations: MergedRelationPlan[]
  /** 被去重删除的重复关系 */
  duplicateRelations: MergedRelationPlan[]
  /** 自关联冲突说明（去重后仍指向单位自身的关系） */
  selfRelations: MergedRelationPlan[]
  /** 闭合矛盾（环路）上的节点单位号 */
  cycleCodes: string[]
  /** 合并后保留单位应具备的曾用号（去重、去与现单位号重复项） */
  mergedFormerCodes: string[]
  /** 冲突明细文案（自关联 / 闭合矛盾），非空时禁止合并 */
  conflicts: string[]
}

/** 合并被拒绝（预检发现冲突），页面据此提示且不写入任何数据 */
export class MergeConflictError extends Error {
  conflicts: string[]
  constructor(conflicts: string[]) {
    super(conflicts.join('；'))
    this.name = 'MergeConflictError'
    this.conflicts = conflicts
  }
}

/** 合并入参不合法（单位不存在、跨探方等） */
export class MergeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MergeValidationError'
  }
}

/** 去重键：有向关系按 A→B，共存视为无向 */
function relationKey(relation: Pick<Relation, 'unitAId' | 'unitBId' | 'type'>): string {
  if (relation.type === '共存') {
    return `共存:${[relation.unitAId, relation.unitBId].sort().join('|')}`
  }
  return `${relation.type}:${relation.unitAId}->${relation.unitBId}`
}

function codeOf(strata: Stratum[], id: string): string {
  return strata.find((item) => item.id === id)?.code ?? id
}

function relationText(relation: Relation, strata: Stratum[]): string {
  return `${codeOf(strata, relation.unitAId)} ${relation.type} ${codeOf(strata, relation.unitBId)}`
}

/** 改写关系端点：source id → keep id，其余不动 */
function remapRelation(relation: Relation, sourceIds: Set<string>, keepId: string): Relation {
  return {
    ...relation,
    unitAId: sourceIds.has(relation.unitAId) ? keepId : relation.unitAId,
    unitBId: sourceIds.has(relation.unitBId) ? keepId : relation.unitBId
  }
}

/**
 * 合并预检：纯函数，不写任何数据。
 * - 器物：待并入单位的全部器物转到保留单位，深度超出保留单位区间的单独标出；
 * - 关系：端点改写为保留单位，与保留单位既有关系（或彼此之间）重复的去重；
 * - 去重后出现自关联（A、B 同指保留单位）或闭合矛盾（有向图成环）即列为冲突，
 *   调用方必须放弃合并，两份记录原样保留。
 */
export function planStratumMerge(input: MergeInput): MergePlan {
  const sourceIds = [...new Set(input.sourceIds)].filter((id) => id !== input.keepId)
  const sourceSet = new Set(sourceIds)

  const keep = input.strata.find((item) => item.id === input.keepId)
  if (!keep) throw new MergeValidationError('保留单位不存在或已被删除，请刷新后重试')
  const sources = input.strata.filter((item) => sourceSet.has(item.id))
  if (sources.length === 0) throw new MergeValidationError('请选择至少一个待并入单位')
  const crossTrench = sources.find((item) => item.trenchId !== keep.trenchId)
  if (crossTrench) {
    throw new MergeValidationError(`待并入单位「${crossTrench.code}」与保留单位「${keep.code}」不属于同一探方，不能合并`)
  }

  // 器物转移与深度越界判定
  const movingArtifacts = input.artifacts.filter((item) => sourceSet.has(item.stratumId))
  const outOfRangeArtifacts = movingArtifacts.filter((item) => isArtifactDepthOutOfRange(item, keep))

  // 受影响的关系：原端点中任一指向被并入单位
  const touchedIds = new Set<string>()
  const touched: Relation[] = []
  input.relations.forEach((relation) => {
    if (sourceSet.has(relation.unitAId) || sourceSet.has(relation.unitBId)) {
      touchedIds.add(relation.id)
      touched.push(relation)
    }
  })
  const untouched = input.relations.filter((relation) => !touchedIds.has(relation.id))

  const remapped = touched.map((relation) => ({
    relation: remapRelation(relation, sourceSet, keep.id),
    fromText: relationText(relation, input.strata)
  }))

  // 去重：以未受影响的既有关系为基准（优先保留它们，避免误删无关记录），
  // 改写后的关系同 key 归并，只保留一条。
  const existingKeys = new Set(untouched.map((relation) => relationKey(relation)))
  const chosenKeys = new Set<string>()
  const finalFromMerged: MergedRelationPlan[] = []
  const duplicateRelations: MergedRelationPlan[] = []
  // 同 key 多条时稳定保留 id 最小（创建更早）的一条
  const sortedRemapped = [...remapped].sort((a, b) => a.relation.id.localeCompare(b.relation.id))
  sortedRemapped.forEach((plan) => {
    const key = relationKey(plan.relation)
    if (existingKeys.has(key) || chosenKeys.has(key)) {
      duplicateRelations.push(plan)
      return
    }
    chosenKeys.add(key)
    finalFromMerged.push(plan)
  })

  // 自关联检测：去重后两端都指向保留单位本身（仅统计本次改写新产生的）
  const selfRelations = finalFromMerged.filter(
    (plan) => plan.relation.unitAId === keep.id && plan.relation.unitBId === keep.id
  )
  const nonSelfMerged = finalFromMerged.filter(
    (plan) => plan.relation.unitAId !== keep.id || plan.relation.unitBId !== keep.id
  )

  // 闭合矛盾检测：在去重后的完整关系集 + 合并后的单位集合上构图
  const mergedRelations = [...untouched, ...nonSelfMerged.map((plan) => plan.relation)]
  const survivingStrata = input.strata.filter((item) => !sourceSet.has(item.id))
  const graph = buildGraph(survivingStrata, mergedRelations)
  const cycleCodes = graph.hasCycle
    ? graph.cyclePath.map((id) => (id === keep.id ? keep.code : codeOf(input.strata, id)))
    : []

  // 曾用号：保留单位原有曾用号 + 被并入单位的单位号及其历史曾用号；
  // 与保留单位现号同名的重复号不收录（现号即该号，再列「曾用 X」只会误导）
  const mergedFormerCodes = [
    ...(keep.formerCodes ?? []),
    ...sources.flatMap((source) => [source.code, ...(source.formerCodes ?? [])])
  ]
    .map((code) => code.trim())
    .filter((code, index, list) => list.indexOf(code) === index && code.toUpperCase() !== keep.code.trim().toUpperCase())

  const conflicts: string[] = []
  selfRelations.forEach((plan) => {
    conflicts.push(
      `去重后关系「${plan.fromText}」两端都指向保留单位「${keep.code}」，形成自关联；请先处理该关系`
    )
  })
  if (cycleCodes.length > 0) {
    conflicts.push(`合并后层位关系将形成闭合矛盾：${cycleCodes.join(' → ')} → ${cycleCodes[0]}；请先调整相关关系`)
  }

  return {
    keep,
    sources,
    movingArtifacts,
    outOfRangeArtifacts,
    finalRelations: nonSelfMerged,
    duplicateRelations,
    selfRelations,
    cycleCodes,
    mergedFormerCodes,
    conflicts
  }
}
