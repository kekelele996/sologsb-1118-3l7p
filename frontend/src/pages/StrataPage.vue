<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Inclusion, Stratum, UnitType } from '@/types'
import { INCLUSIONS, UNIT_TYPES, isCodeDuplicated, isDepthInverted, isDepthWithin, stratumThickness } from '@/types'
import StratumDepthBar from '@/components/common/StratumDepthBar.vue'
import TrenchTag from '@/components/common/TrenchTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useStratumOrder } from '@/hooks/useStratumOrder'
import { stratumStore, MergeConflictError } from '@/stores/stratumStore'
import { trenchStore } from '@/stores/trenchStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { planMergeStrata, type MergePlan } from '@/utils/merge'
import { uid } from '@/utils/id'

const trenchState = useStore(trenchStore)
const stratumState = useStore(stratumStore)
const artifactState = useStore(artifactStore)
const relationState = useStore(relationStore)

const { result: order } = useStratumOrder(
  computed(() => stratumState.strata),
  computed(() => relationState.relations)
)

const filterTrenchId = ref('')
const filterType = ref<UnitType | ''>('')
const depthFrom = ref<number | undefined>(undefined)
const depthTo = ref<number | undefined>(undefined)
const selectedIds = ref<string[]>([])
const batchType = ref<UnitType>('地层')

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)

const form = reactive({
  trenchId: '',
  code: '',
  type: '地层' as UnitType,
  openLayer: '第①层',
  topDepth: 0,
  bottomDepth: 0.3,
  soil: '',
  inclusions: [] as Inclusion[],
  formation: '',
  date: new Date().toISOString().slice(0, 10),
  drawingNo: ''
})

const visible = computed(() =>
  stratumState.strata.filter((item) => {
    if (filterTrenchId.value && item.trenchId !== filterTrenchId.value) return false
    if (filterType.value && item.type !== filterType.value) return false
    if (depthFrom.value !== undefined && item.bottomDepth < depthFrom.value) return false
    if (depthTo.value !== undefined && item.topDepth > depthTo.value) return false
    return true
  })
)

function trenchLabel(trenchId: string): string {
  const trench = trenchState.trenches.find((item) => item.id === trenchId)
  return trench ? `${trench.area} · ${trench.code}` : '未知探方'
}

function artifactsOf(stratumId: string): number {
  return artifactState.artifacts.filter((item) => item.stratumId === stratumId).reduce((sum, item) => sum + item.count, 0)
}

/** 该单位下深度越界的出土物（持久标记或实时不在区间内） */
function outOfRangeOf(stratum: Stratum) {
  return artifactState.artifacts.filter(
    (item) => item.stratumId === stratum.id && (!!item.depthNote || !isDepthWithin(stratum, item.z))
  )
}

function invertedOf(stratum: Stratum): boolean {
  return isDepthInverted(stratum)
}

function duplicatedOf(stratum: Stratum): boolean {
  return isCodeDuplicated(stratumState.strata, stratum)
}

function rowClass(param: { row: Stratum }): string {
  if (invertedOf(param.row)) return 'inverted-row'
  if (duplicatedOf(param.row)) return 'duplicate-row'
  if (outOfRangeOf(param.row).length > 0) return 'oor-row'
  return ''
}

/** 与层位关系矛盾的告警（按单位过滤） */
const conflictOf = (code: string): string | null =>
  order.value.conflicts.find((item) => item.startsWith(code)) ?? null

watch(
  () => [trenchState.trenches.length, form.trenchId] as const,
  () => {
    if (!form.trenchId && trenchState.trenches.length > 0) form.trenchId = trenchState.trenches[0].id
  },
  { immediate: true }
)

function resetForm(): void {
  editingId.value = null
  form.trenchId = trenchState.trenches[0]?.id ?? ''
  form.code = ''
  form.type = '地层'
  form.openLayer = '第①层'
  form.topDepth = 0
  form.bottomDepth = 0.3
  form.soil = ''
  form.inclusions = []
  form.formation = ''
  form.date = new Date().toISOString().slice(0, 10)
  form.drawingNo = ''
}

function openCreate(): void {
  resetForm()
  dialogVisible.value = true
}

function openEdit(stratum: Stratum): void {
  editingId.value = stratum.id
  Object.assign(form, {
    trenchId: stratum.trenchId,
    code: stratum.code,
    type: stratum.type,
    openLayer: stratum.openLayer,
    topDepth: stratum.topDepth,
    bottomDepth: stratum.bottomDepth,
    soil: stratum.soil,
    inclusions: [...stratum.inclusions],
    formation: stratum.formation,
    date: stratum.date,
    drawingNo: stratum.drawingNo
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  if (!form.trenchId) {
    ElMessage.warning('请选择所属探方')
    return
  }
  if (!form.code.trim()) {
    ElMessage.warning('请填写单位号（如 H12、L03）')
    return
  }
  if (form.topDepth < 0 || form.bottomDepth < 0) {
    ElMessage.warning('深度不能为负值')
    return
  }
  const candidate = { id: editingId.value ?? uid('st'), trenchId: form.trenchId, code: form.code.trim().toUpperCase() }
  if (isCodeDuplicated(stratumState.strata, candidate)) {
    ElMessage.error(`同一探方内单位号「${candidate.code}」已存在，请更换`)
    return
  }
  const row: Stratum = {
    id: candidate.id,
    trenchId: candidate.trenchId,
    code: candidate.code,
    type: form.type,
    openLayer: form.openLayer.trim(),
    topDepth: Number(form.topDepth) || 0,
    bottomDepth: Number(form.bottomDepth) || 0,
    soil: form.soil.trim(),
    inclusions: [...form.inclusions],
    formation: form.formation.trim(),
    date: form.date,
    drawingNo: form.drawingNo.trim(),
    // 曾用号是合并留存的档案信息，普通编辑不覆盖
    formerCodes: editingId.value ? stratumState.strata.find((item) => item.id === editingId.value)?.formerCodes ?? [] : []
  }
  await stratumStore.getState().save(row)
  if (isDepthInverted(row)) {
    ElMessage.warning(`已保存，但「${row.code}」上界深度大于下界，层序倒置需复核`)
  } else {
    ElMessage.success(`地层单位 ${row.code} 已保存（厚 ${stratumThickness(row)} m）`)
  }
  dialogVisible.value = false
}

async function remove(stratum: Stratum): Promise<void> {
  const count = artifactState.artifacts.filter((item) => item.stratumId === stratum.id).length
  const relations = relationState.relations.filter(
    (item) => item.unitAId === stratum.id || item.unitBId === stratum.id
  ).length
  if (count > 0 || relations > 0) {
    ElMessage.error(`「${stratum.code}」下仍有 ${count} 件出土物、${relations} 条层位关系，请先清理`)
    return
  }
  await ElMessageBox.confirm(`确认删除地层单位「${stratum.code}」？`, '删除确认', { type: 'warning' })
  await stratumStore.getState().remove(stratum.id)
  ElMessage.success('地层单位已删除')
}

async function applyBatchType(): Promise<void> {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要调整的单位')
    return
  }
  await stratumStore.getState().bulkSetType(selectedIds.value, batchType.value)
  ElMessage.success(`已把 ${selectedIds.value.length} 个单位的类型调整为「${batchType.value}」`)
}

/* ---------- 地层单位合并 ---------- */

const mergeVisible = ref(false)
const mergeTrenchId = ref('')
const mergeTargetId = ref('')
const mergeSourceId = ref('')
const merging = ref(false)

/** 同探方内可选单位 */
const mergeCandidates = computed(() =>
  stratumState.strata.filter((item) => !mergeTrenchId.value || item.trenchId === mergeTrenchId.value)
)
const mergeTargetOptions = computed(() => mergeCandidates.value.filter((item) => item.id !== mergeSourceId.value))
const mergeSourceOptions = computed(() => mergeCandidates.value.filter((item) => item.id !== mergeTargetId.value))

/** 预检明细（纯模拟，不写数据） */
const mergePlan = computed<MergePlan | null>(() => {
  if (!mergeTargetId.value || !mergeSourceId.value) return null
  if (mergeTargetId.value === mergeSourceId.value) return null
  return planMergeStrata({
    strata: stratumState.strata,
    artifacts: artifactState.artifacts,
    relations: relationState.relations,
    targetId: mergeTargetId.value,
    sourceId: mergeSourceId.value
  })
})

function unitBrief(stratumId: string): string {
  const item = stratumState.strata.find((row) => row.id === stratumId)
  return item ? `${item.code}（${item.type} · ${item.topDepth}–${item.bottomDepth} m）` : '—'
}

/** 改写后关系的两端单位号（预检时待并入单位已用保留单位号展示） */
function rewrittenEndText(plan: MergePlan, endpointId: string): string {
  const id = endpointId === plan.source.id ? plan.target.id : endpointId
  return unitBrief(id)
}

function openMerge(): void {
  // 勾选了两个同探方单位时直接带入；否则取当前筛选探方
  const picked = selectedIds.value
    .map((id) => stratumState.strata.find((row) => row.id === id))
    .filter((item): item is Stratum => !!item)
  const sameTrench = picked.filter((item) => item.trenchId === picked[0]?.trenchId)
  mergeTrenchId.value = sameTrench.length === 2 ? sameTrench[0].trenchId : filterTrenchId.value || trenchState.trenches[0]?.id || ''
  if (sameTrench.length === 2) {
    mergeTargetId.value = sameTrench[0].id
    mergeSourceId.value = sameTrench[1].id
  } else {
    mergeTargetId.value = ''
    mergeSourceId.value = ''
  }
  mergeVisible.value = true
}

async function confirmMerge(): Promise<void> {
  if (!mergePlan.value) return
  const { target, source, artifactPieceCount, rewrittenCount, duplicateCount, outOfRangeArtifacts } = mergePlan.value
  try {
    await ElMessageBox.confirm(
      `确认把「${source.code}」并入「${target.code}」？将转入出土物合计 ${artifactPieceCount} 件、改写层位关系 ${rewrittenCount} 条` +
        (duplicateCount > 0 ? `、去重删除 ${duplicateCount} 条` : '') +
        (outOfRangeArtifacts.length > 0 ? `；其中 ${outOfRangeArtifacts.length} 件出土深度越界会标出` : '') +
        '。旧单位号将作为曾用号保留，操作不可自动撤销。',
      '合并确认',
      { type: 'warning', confirmButtonText: '确认合并', cancelButtonText: '再想想' }
    )
  } catch {
    return
  }

  merging.value = true
  try {
    await stratumStore.getState().mergeUnits(mergeTargetId.value, mergeSourceId.value)
    ElMessage.success(
      `已合并：${source.code} 并入 ${target.code}` +
        (outOfRangeArtifacts.length > 0 ? `，${outOfRangeArtifacts.length} 件出土物深度越界已标出，请核对层位` : '')
    )
    mergeVisible.value = false
  } catch (error) {
    if (error instanceof MergeConflictError) {
      // 预检冲突：两份记录原样保留（计划文本已在对话框内展示，这里再提示一次）
      ElMessage.error('存在冲突，已取消合并，两个单位原样保留')
    } else {
      // 写入中途失败：事务回滚，两份记录原样保留
      ElMessage.error('合并写入失败，数据已回滚，两个单位原样保留')
    }
  } finally {
    merging.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">地层单位编目表</h2>
        <p class="page-sub">
          按类型与深度区间筛选；层序倒置（上界大于下界）与同一探方内单位号重复即时高亮提示，深度刻度条展示厚度。
        </p>
      </div>
      <div class="head-actions">
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>新建地层单位
        </el-button>
        <el-button type="warning" plain @click="openMerge">
          <el-icon><Connection /></el-icon>合并重复单位
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="order.inverted.length > 0 || order.duplicateCodes.length > 0"
      class="alert"
      type="warning"
      :closable="false"
      show-icon
      :title="`发现 ${order.inverted.length} 个层序倒置单位、${order.duplicateCodes.length} 个重复单位号`"
    >
      <template #default>
        <p v-if="order.inverted.length > 0">
          层序倒置：{{ order.inverted.map((item) => item.code).join('、') }}（上界深度大于下界深度）
        </p>
        <p v-if="order.duplicateCodes.length > 0">单位号重复：{{ order.duplicateCodes.join('、') }}</p>
        <p v-if="order.conflicts.length > 0">
          与层位关系矛盾：{{ order.conflicts.join('；') }}
        </p>
      </template>
    </el-alert>
    <el-alert
      v-else
      class="alert"
      type="success"
      :closable="false"
      show-icon
      title="层序与单位号校验通过"
    />

    <div class="toolbar">
      <el-select v-model="filterTrenchId" placeholder="全部探方" clearable style="width: 190px">
        <el-option v-for="trench in trenchState.trenches" :key="trench.id" :label="`${trench.area} · ${trench.code}`" :value="trench.id" />
      </el-select>
      <el-select v-model="filterType" placeholder="全部类型" clearable style="width: 130px">
        <el-option v-for="type in UNIT_TYPES" :key="type" :label="type" :value="type" />
      </el-select>
      <div class="depth">
        <span class="muted">深度区间（米）</span>
        <el-input-number v-model="depthFrom" :min="0" :step="0.1" :controls="false" placeholder="起" style="width: 100px" />
        <span>—</span>
        <el-input-number v-model="depthTo" :min="0" :step="0.1" :controls="false" placeholder="止" style="width: 100px" />
      </div>
      <el-select v-model="batchType" style="width: 130px">
        <el-option v-for="type in UNIT_TYPES" :key="type" :label="type" :value="type" />
      </el-select>
      <el-button type="primary" plain @click="applyBatchType">批量调整类型</el-button>
      <el-tag type="info" effect="plain">命中 {{ visible.length }} / {{ stratumState.strata.length }} 个单位</el-tag>
    </div>

    <el-table
      :data="visible"
      border
      stripe
      row-key="id"
      :row-class-name="rowClass"
      @selection-change="(rows: Stratum[]) => (selectedIds = rows.map((row) => row.id))"
    >
      <el-table-column type="selection" width="46" />
      <el-table-column label="序号" width="70">
        <template #default="{ row }: { row: Stratum }">{{ order.indexOf.get(row.id) ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="探方" width="150">
        <template #default="{ row }: { row: Stratum }">
          <span class="mono">{{ trenchLabel(row.trenchId) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="单位号" width="150">
        <template #default="{ row }: { row: Stratum }">
          <span class="mono">{{ row.code }}</span>
          <el-tag v-if="duplicatedOf(row)" type="warning" size="small" effect="dark" class="mini">重复</el-tag>
          <el-tag
            v-for="code in row.formerCodes ?? []"
            :key="code"
            type="info"
            size="small"
            effect="plain"
            class="mini former"
            :title="`曾用单位号 ${code}（已并入）`"
          >
            曾用 {{ code }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="120">
        <template #default="{ row }: { row: Stratum }">
          <TrenchTag :unit-type="row.type" size="small" />
        </template>
      </el-table-column>
      <el-table-column label="深度刻度" width="250">
        <template #default="{ row }: { row: Stratum }">
          <StratumDepthBar :stratum="row" :length="180" />
        </template>
      </el-table-column>
      <el-table-column label="开口层位" width="110" prop="openLayer" />
      <el-table-column label="土质土色" min-width="150" prop="soil" show-overflow-tooltip />
      <el-table-column label="包含物" width="150">
        <template #default="{ row }: { row: Stratum }">
          <el-tag v-for="item in row.inclusions" :key="item" size="small" effect="plain" class="mini">{{ item }}</el-tag>
          <span v-if="row.inclusions.length === 0" class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="出土物" width="120">
        <template #default="{ row }: { row: Stratum }">
          <span>{{ artifactsOf(row.id) }} 件</span>
          <el-tooltip
            v-if="outOfRangeOf(row).length > 0"
            placement="top"
            effect="dark"
            :content="`${outOfRangeOf(row).length} 件出土物深度越界：${outOfRangeOf(row)
              .map((item) => item.code)
              .join('、')}`"
          >
            <el-tag type="danger" size="small" effect="dark" class="mini">越界 {{ outOfRangeOf(row).length }}</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="校验" width="110">
        <template #default="{ row }: { row: Stratum }">
          <el-tag v-if="invertedOf(row)" type="danger" size="small" effect="dark">层序倒置</el-tag>
          <el-tag v-else-if="conflictOf(row.code)" type="warning" size="small" effect="dark">关系矛盾</el-tag>
          <el-tag v-else-if="outOfRangeOf(row).length > 0" type="danger" size="small" effect="plain">深度越界</el-tag>
          <el-tag v-else type="success" size="small" effect="plain">正常</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }: { row: Stratum }">
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑地层单位' : '新建地层单位'" width="680px">
      <el-form label-width="110px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="所属探方" required>
              <el-select v-model="form.trenchId" style="width: 100%">
                <el-option v-for="trench in trenchState.trenches" :key="trench.id" :label="`${trench.area} · ${trench.code}`" :value="trench.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="单位号" required>
              <el-input v-model="form.code" placeholder="如 H12、L03" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="单位类型">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="type in UNIT_TYPES" :key="type" :label="type" :value="type" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="开口层位">
              <el-input v-model="form.openLayer" placeholder="如 第②层下" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="上界深度(m)">
              <el-input-number v-model="form.topDepth" :min="0" :step="0.05" :precision="2" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="下界深度(m)">
              <el-input-number v-model="form.bottomDepth" :min="0" :step="0.05" :precision="2" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="厚度">
              <el-input :model-value="`${Math.abs(form.bottomDepth - form.topDepth).toFixed(2)} m`" disabled />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="土质土色">
          <el-input v-model="form.soil" placeholder="如 灰褐色砂质黏土，疏松" />
        </el-form-item>
        <el-form-item label="包含物">
          <el-checkbox-group v-model="form.inclusions">
            <el-checkbox v-for="item in INCLUSIONS" :key="item" :value="item">{{ item }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="堆积成因">
          <el-input v-model="form.formation" placeholder="如 生活垃圾坑" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="发掘日期">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="绘图/拍照号">
              <el-input v-model="form.drawingNo" placeholder="如 T0501-北壁-02" />
            </el-form-item>
          </el-col>
        </el-row>
        <p v-if="form.topDepth > form.bottomDepth" class="warn">上界深度大于下界深度，保存后将标记为「层序倒置」</p>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="mergeVisible" title="合并重复地层单位" width="720px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="alert"
        title="把同一探方内重复登记的单位并为一个：器物与层位关系集中到保留单位，旧单位号作为曾用号留存"
      />
      <el-form label-width="110px">
        <el-form-item label="所属探方" required>
          <el-select v-model="mergeTrenchId" placeholder="先选择探方" style="width: 320px" @update:model-value="() => { mergeTargetId = ''; mergeSourceId = '' }">
            <el-option v-for="trench in trenchState.trenches" :key="trench.id" :label="`${trench.area} · ${trench.code}`" :value="trench.id" />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="保留单位" required>
              <el-select v-model="mergeTargetId" placeholder="合并后保留此单位" filterable style="width: 100%">
                <el-option
                  v-for="item in mergeTargetOptions"
                  :key="item.id"
                  :label="`${item.code}（${item.type} · ${item.topDepth}–${item.bottomDepth} m）`"
                  :value="item.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="待并入单位" required>
              <el-select v-model="mergeSourceId" placeholder="合并后删除此单位" filterable style="width: 100%">
                <el-option
                  v-for="item in mergeSourceOptions"
                  :key="item.id"
                  :label="`${item.code}（${item.type} · ${item.topDepth}–${item.bottomDepth} m）`"
                  :value="item.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <div v-if="!mergePlan" class="merge-empty muted">请选择保留单位与待并入单位，系统会先模拟合并结果供核对。</div>

      <template v-else>
        <el-card shadow="never" class="merge-card">
          <template #header>
            <span class="mono">{{ mergePlan.source.code }} → 并入 → {{ mergePlan.target.code }}</span>
          </template>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="转入出土物">
              <b :class="{ 'oor-text': mergePlan.outOfRangeArtifacts.length > 0 }">
                {{ mergePlan.artifacts.length }} 条登记 / 合计 {{ mergePlan.artifactPieceCount }} 件
              </b>
            </el-descriptions-item>
            <el-descriptions-item label="其中深度越界">
              <b :class="mergePlan.outOfRangeArtifacts.length > 0 ? 'oor-text' : ''">
                {{ mergePlan.outOfRangeArtifacts.length }} 件（将逐条标出）
              </b>
            </el-descriptions-item>
            <el-descriptions-item label="改写层位关系">{{ mergePlan.rewrittenCount }} 条端点改写</el-descriptions-item>
            <el-descriptions-item label="去重删除">{{ mergePlan.duplicateCount }} 条重复关系</el-descriptions-item>
          </el-descriptions>

          <div v-if="mergePlan.rewrittenRelations.length > 0" class="merge-block">
            <p class="block-title">将改写的关系（{{ mergePlan.rewrittenRelations.length }}）</p>
            <ul class="merge-list">
              <li v-for="item in mergePlan.rewrittenRelations" :key="item.relation.id">
                <span class="mono">{{ rewrittenEndText(mergePlan, item.updated.unitAId) }}</span>
                <el-tag size="small" effect="dark" class="mini">{{ item.relation.type }}</el-tag>
                <span class="mono">{{ rewrittenEndText(mergePlan, item.updated.unitBId) }}</span>
                <span class="muted">（{{ item.detail }}）</span>
              </li>
            </ul>
          </div>

          <div v-if="mergePlan.duplicateRelations.length > 0" class="merge-block">
            <p class="block-title">去重后删除的重复关系（{{ mergePlan.duplicateRelations.length }}）</p>
            <ul class="merge-list">
              <li v-for="item in mergePlan.duplicateRelations" :key="item.id" class="muted mono">
                {{ rewrittenEndText(mergePlan, item.unitAId) }} {{ item.type }} {{ rewrittenEndText(mergePlan, item.unitBId) }}
              </li>
            </ul>
          </div>

          <div v-if="mergePlan.outOfRangeArtifacts.length > 0" class="merge-block">
            <p class="block-title oor-text">深度越界器物（{{ mergePlan.outOfRangeArtifacts.length }} 件登记）</p>
            <ul class="merge-list">
              <li v-for="item in mergePlan.outOfRangeArtifacts" :key="item.artifact.id">
                <el-tag type="danger" size="small" effect="dark" class="mini">越界</el-tag>
                <span class="mono">{{ item.artifact.code }}</span>
                <span class="muted">Z = {{ item.artifact.z }} m，不在保留单位 {{ mergePlan.target.code }} 区间内</span>
              </li>
            </ul>
          </div>
        </el-card>

        <el-alert
          v-if="mergePlan.conflicts.length > 0"
          type="error"
          class="alert"
          :closable="false"
          show-icon
          title="检测到冲突，不能合并；两份记录将原样保留"
        >
          <ul class="merge-conflicts">
            <li v-for="(text, index) in mergePlan.conflicts" :key="index">{{ text }}</li>
          </ul>
        </el-alert>
      </template>

      <template #footer>
        <el-button @click="mergeVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="merging"
          :disabled="!mergePlan || mergePlan.conflicts.length > 0"
          @click="confirmMerge"
        >
          确认合并
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.alert {
  margin-bottom: 14px;
}
.head-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.depth {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mini {
  margin-left: 4px;
}
.former {
  margin-top: 2px;
}
.warn {
  margin: 0;
  color: #c0392b;
  font-size: 12px;
}
.oor-row {
  background: #fdf6ec !important;
}
.oor-text {
  color: #c0392b;
}
.merge-empty {
  padding: 18px;
  text-align: center;
}
.merge-card {
  border-radius: 10px;
}
.merge-block {
  margin-top: 12px;
}
.block-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}
.merge-list {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.9;
}
.merge-conflicts {
  margin: 4px 0 0;
  padding-left: 18px;
  line-height: 1.8;
}
</style>
