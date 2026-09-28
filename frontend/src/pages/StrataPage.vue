<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Artifact, Inclusion, Stratum, UnitType } from '@/types'
import { INCLUSIONS, UNIT_TYPES, isArtifactDepthOutOfRange, isCodeDuplicated, isDepthInverted, stratumThickness } from '@/types'
import StratumDepthBar from '@/components/common/StratumDepthBar.vue'
import TrenchTag from '@/components/common/TrenchTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useStratumOrder } from '@/hooks/useStratumOrder'
import { stratumStore } from '@/stores/stratumStore'
import { trenchStore } from '@/stores/trenchStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { MergeConflictError, MergeValidationError, planStratumMerge, type MergePlan } from '@/utils/stratumMerge'
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

function strataById(id: string | null): Stratum | null {
  return id ? stratumState.strata.find((item) => item.id === id) ?? null : null
}

function artifactsOf(stratumId: string): number {
  return artifactState.artifacts.filter((item) => item.stratumId === stratumId).reduce((sum, item) => sum + item.count, 0)
}

/** 合并等原因导致深度越界的器物（持久化标记或实时区间判定，任一命中即标出） */
function outOfRangeOf(stratum: Stratum): Artifact[] {
  return artifactState.artifacts.filter(
    (item) => item.stratumId === stratum.id && (item.depthOutOfRange || isArtifactDepthOutOfRange(item, stratum))
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
    drawingNo: form.drawingNo.trim()
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

/* ---------------- 地层单位合并 ---------------- */

const mergeVisible = ref(false)
const mergeTrenchId = ref('')
const mergeKeepId = ref('')
const mergeSourceIds = ref<string[]>([])
const merging = ref(false)

const mergeCandidates = computed(() =>
  stratumState.strata
    .filter((item) => !mergeTrenchId.value || item.trenchId === mergeTrenchId.value)
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
)

const mergeKeep = computed(() => stratumState.strata.find((item) => item.id === mergeKeepId.value) ?? null)

const mergeSourceOptions = computed(() => mergeCandidates.value.filter((item) => item.id !== mergeKeepId.value))

const mergePreview = computed<{ plan: MergePlan | null; error: string | null }>(() => {
  if (!mergeKeepId.value || mergeSourceIds.value.length === 0) return { plan: null, error: null }
  try {
    return {
      plan: planStratumMerge({
        keepId: mergeKeepId.value,
        sourceIds: mergeSourceIds.value,
        strata: stratumState.strata,
        artifacts: artifactState.artifacts,
        relations: relationState.relations
      }),
      error: null
    }
  } catch (error) {
    return { plan: null, error: error instanceof MergeValidationError ? error.message : '预检失败，请检查所选单位' }
  }
})

function openMerge(): void {
  mergeTrenchId.value = filterTrenchId.value || trenchState.trenches[0]?.id || ''
  mergeKeepId.value = ''
  mergeSourceIds.value = []
  mergeVisible.value = true
}

watch(mergeTrenchId, () => {
  mergeKeepId.value = ''
  mergeSourceIds.value = []
})

watch(mergeKeepId, () => {
  mergeSourceIds.value = []
})

async function confirmMerge(): Promise<void> {
  const plan = mergePreview.value.plan
  if (!plan || plan.conflicts.length > 0) return
  await ElMessageBox.confirm(
    `确认把 ${plan.sources.map((item) => item.code).join('、')} 并入「${plan.keep.code}」？合并后旧单位号会作为曾用号保留，该操作不可拆分撤销。`,
    '合并确认',
    { type: 'warning', confirmButtonText: '确认合并', cancelButtonText: '再核对一下' }
  )
  merging.value = true
  try {
    const result = await stratumStore.getState().mergeUnits(mergeKeepId.value, mergeSourceIds.value)
    mergeVisible.value = false
    if (result.outOfRangeArtifacts.length > 0) {
      ElMessage.warning(
        `合并完成：转移 ${result.movingArtifacts.length} 件器物，其中 ${result.outOfRangeArtifacts.length} 件出土深度超出「${result.keep.code}」区间，已标出请复核`
      )
    } else {
      ElMessage.success(`合并完成：${result.sources.map((item) => item.code).join('、')} 已并入「${result.keep.code}」`)
    }
  } catch (error) {
    if (error instanceof MergeConflictError) {
      ElMessage({ type: 'error', duration: 6000, showClose: true, message: `存在冲突，未执行合并，两份记录原样保留：${error.conflicts.join('；')}` })
    } else if (error !== 'cancel' && error !== 'close') {
      ElMessage.error('合并写入中途失败，数据已回滚，两份记录原样保留')
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
      <el-button type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>新建地层单位
      </el-button>
      <el-button type="warning" plain @click="openMerge">
        <el-icon><Connection /></el-icon>合并重复单位
      </el-button>
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
        <p v-if="order.duplicateCodes.length > 0" class="dup-line">
          <span>单位号重复：{{ order.duplicateCodes.join('、') }}</span>
          <el-button type="warning" size="small" plain @click="openMerge">合并这些重复单位</el-button>
        </p>
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
          <div v-if="row.formerCodes && row.formerCodes.length > 0" class="former">
            <el-tag
              v-for="former in row.formerCodes"
              :key="former"
              size="small"
              effect="plain"
              class="mini"
              title="曾用号：该单位由重复单位合并而来"
            >
              曾用 {{ former }}
            </el-tag>
          </div>
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
            :content="`${outOfRangeOf(row).map((item) => item.code).join('、')} 出土深度不在 ${row.code} 区间内`"
          >
            <el-tag type="danger" size="small" effect="dark" class="mini">越界 {{ outOfRangeOf(row).length }}</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="校验" width="110">
        <template #default="{ row }: { row: Stratum }">
          <el-tag v-if="invertedOf(row)" type="danger" size="small" effect="dark">层序倒置</el-tag>
          <el-tag v-else-if="conflictOf(row.code)" type="warning" size="small" effect="dark">关系矛盾</el-tag>
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
        <p v-if="editingId && strataById(editingId)?.formerCodes?.length" class="former-readonly">
          曾用号（合并留痕，不可手工修改）：
          <el-tag
            v-for="former in strataById(editingId)?.formerCodes ?? []"
            :key="former"
            size="small"
            effect="plain"
            class="mini"
          >
            {{ former }}
          </el-tag>
        </p>
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
        class="merge-tip"
        title="同一探方内重复的单位号可合并：出土物转到保留单位，层位关系端点改写并自动去重；旧单位号作为曾用号留在保留单位上。仅限同一探方内合并。"
      />
      <el-form label-width="110px">
        <el-form-item label="所属探方" required>
          <el-select v-model="mergeTrenchId" placeholder="选择探方" style="width: 100%">
            <el-option v-for="trench in trenchState.trenches" :key="trench.id" :label="`${trench.area} · ${trench.code}`" :value="trench.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="保留单位" required>
          <el-select v-model="mergeKeepId" placeholder="合并后保留的单位（数据并入此单位）" filterable style="width: 100%">
            <el-option
              v-for="item in mergeCandidates"
              :key="item.id"
              :label="`${item.code}（${item.type} · ${item.topDepth}–${item.bottomDepth} m）`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="待并入单位" required>
          <el-select
            v-model="mergeSourceIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            placeholder="选择要并入保留单位的重复单位（可多选）"
            filterable
            style="width: 100%"
          >
            <el-option
              v-for="item in mergeSourceOptions"
              :key="item.id"
              :label="`${item.code}（${item.type} · ${item.topDepth}–${item.bottomDepth} m）`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <div v-if="mergeKeep" class="merge-keep">
        保留单位深度区间：<strong>{{ mergeKeep.topDepth }}–{{ mergeKeep.bottomDepth }} m</strong>
        <span v-if="mergeKeep.formerCodes && mergeKeep.formerCodes.length > 0" class="muted">
          · 已有曾用号：{{ mergeKeep.formerCodes.join('、') }}
        </span>
      </div>

      <el-alert
        v-if="mergePreview.error"
        type="error"
        :closable="false"
        show-icon
        class="merge-preview"
        :title="mergePreview.error"
      />

      <template v-else-if="mergePreview.plan">
        <el-alert
          v-if="mergePreview.plan.conflicts.length > 0"
          type="error"
          :closable="false"
          show-icon
          class="merge-preview"
          title="预检发现冲突，合并不会执行，两份记录原样保留"
        >
          <ul class="conflict-list">
            <li v-for="(text, index) in mergePreview.plan.conflicts" :key="index">{{ text }}</li>
          </ul>
        </el-alert>

        <div class="merge-stats">
          <div class="stat">
            <span class="num">{{ mergePreview.plan.movingArtifacts.length }}</span>
            <span class="lab">转移器物（条记录）</span>
          </div>
          <div class="stat">
            <span class="num">{{ mergePreview.plan.movingArtifacts.reduce((sum, item) => sum + item.count, 0) }}</span>
            <span class="lab">转移件数合计</span>
          </div>
          <div class="stat">
            <span class="num">{{ mergePreview.plan.finalRelations.length }}</span>
            <span class="lab">改写关系</span>
          </div>
          <div class="stat">
            <span class="num">{{ mergePreview.plan.duplicateRelations.length }}</span>
            <span class="lab">去重删除关系</span>
          </div>
          <div class="stat" :class="{ warn: mergePreview.plan.outOfRangeArtifacts.length > 0 }">
            <span class="num">{{ mergePreview.plan.outOfRangeArtifacts.length }}</span>
            <span class="lab">深度越界器物</span>
          </div>
        </div>

        <el-alert
          v-if="mergePreview.plan.outOfRangeArtifacts.length > 0"
          type="warning"
          :closable="false"
          show-icon
          class="merge-preview"
          :title="`以下 ${mergePreview.plan.outOfRangeArtifacts.length} 件器物的出土深度不在保留单位「${mergePreview.plan.keep.code}」区间内，合并后将标出复核：`"
        >
          <p class="ooc-list">
            {{ mergePreview.plan.outOfRangeArtifacts.map((item) => `${item.code}（Z=${item.z} m）`).join('、') }}
          </p>
        </el-alert>

        <el-alert
          v-if="mergePreview.plan.duplicateRelations.length > 0"
          type="info"
          :closable="false"
          show-icon
          class="merge-preview"
          title="以下关系与保留单位既有关系重复，将去重删除（不影响其他关系）："
        >
          <p class="ooc-list">
            {{ mergePreview.plan.duplicateRelations.map((item) => `${item.fromText}（${item.relation.basis}）`).join('；') }}
          </p>
        </el-alert>

        <p class="merge-former muted">
          合并后保留单位「{{ mergePreview.plan.keep.code }}」的曾用号：
          {{ mergePreview.plan.mergedFormerCodes.length > 0 ? mergePreview.plan.mergedFormerCodes.join('、') : '（无新增）' }}
        </p>
      </template>

      <p v-else class="muted merge-placeholder">请选择保留单位与至少一个待并入单位，系统将在确认前列出影响范围。</p>

      <template #footer>
        <el-button @click="mergeVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="merging"
          :disabled="!mergePreview.plan || mergePreview.plan.conflicts.length > 0"
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
.depth {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mini {
  margin-left: 4px;
}
.former {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.former .mini {
  margin-left: 0;
  color: #8a5a2b;
}
.former-readonly {
  margin: 4px 0 0;
  font-size: 12px;
  color: #8a5a2b;
}
.warn {
  margin: 0;
  color: #c0392b;
  font-size: 12px;
}
.merge-tip {
  margin-bottom: 14px;
}
.merge-preview {
  margin-top: 10px;
}
.merge-keep {
  padding: 8px 12px;
  margin-bottom: 10px;
  font-size: 13px;
  background: #f7f4ee;
  border-radius: 8px;
}
.merge-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.merge-stats .stat {
  flex: 1 1 110px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 8px;
  background: #fbfaf6;
  border: 1px solid #e6ded0;
  border-radius: 10px;
}
.merge-stats .stat .num {
  font-size: 20px;
  font-weight: 600;
  color: #a9762f;
}
.merge-stats .stat.warn .num {
  color: #c0392b;
}
.merge-stats .stat .lab {
  font-size: 12px;
  color: #7d7264;
}
.conflict-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
.conflict-list li {
  line-height: 1.7;
}
.ooc-list {
  margin: 4px 0 0;
  line-height: 1.7;
}
.merge-former {
  margin: 10px 0 0;
  font-size: 12px;
}
.merge-placeholder {
  margin: 14px 0 4px;
}
.dup-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
