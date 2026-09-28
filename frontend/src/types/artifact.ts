/** 器物类别 */
export const ARTIFACT_CATEGORIES = ['陶器', '瓷器', '石器', '骨器', '铜器'] as const
export type ArtifactCategory = (typeof ARTIFACT_CATEGORIES)[number]

/** 残整程度 */
export const COMPLETENESS = ['完整', '可复原', '残片'] as const
export type Completeness = (typeof COMPLETENESS)[number]

/** Artifact 出土物 */
export interface Artifact {
  id: string
  /** 所属地层单位（登记时锁定） */
  stratumId: string
  /** 器物编号 */
  code: string
  category: ArtifactCategory
  /** 件数 */
  count: number
  completeness: Completeness
  /** 探方内坐标 X（米） */
  x: number
  /** 探方内坐标 Y（米） */
  y: number
  /** 探方内坐标 Z（距地表深度，米） */
  z: number
  date: string
  /** 提取人 */
  collector: string
  /** 临时存放位置 */
  tempLocation: string
  /**
   * 深度越界标记：地层单位合并后，该器物出土深度超出保留单位深度区间时置为 true，
   * 作为复核痕迹持久保留（不会因后续修改区间而自动消失）。
   */
  depthOutOfRange?: boolean
}

/**
 * 出土深度是否落在地层单位深度区间之外（层序倒置的区间按上下界包络处理）。
 * 合并预检与各页面展示统一用此判断。
 */
export function isArtifactDepthOutOfRange(
  artifact: Pick<Artifact, 'z'>,
  stratum: Pick<import('./stratum').Stratum, 'topDepth' | 'bottomDepth'>
): boolean {
  const upper = Math.min(stratum.topDepth, stratum.bottomDepth)
  const lower = Math.max(stratum.topDepth, stratum.bottomDepth)
  return artifact.z < upper || artifact.z > lower
}
