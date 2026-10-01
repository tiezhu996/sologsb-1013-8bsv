import type {
  CoreField,
  Cue,
  CueKind,
  Scene,
  ShowData,
} from 'stage-cue-editor/models/show';
import { CORE_FIELDS } from 'stage-cue-editor/models/show';

/**
 * 后台换场单：只承载「事实」。
 * - sceneOrder / scenes：场次顺序与场次结构
 * - cues：每条提示的核心字段事实（不含时间轴 offset、备注、前置依赖）
 * - calls：上下场与人员到场安排
 * 换场单不持有任何本地编排状态，也不修改本地已确认的内容。
 */
export interface RunSheetCueFact {
  cueId: string;
  sceneId: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string[];
  cast: string[];
  entrance: string;
  exit: string;
  personnel: string[];
}

export interface RunSheetSceneFact {
  id: string;
  act: string;
  name: string;
  title: string;
  startTime: string;
}

export interface CallRecord {
  id: string;
  cueId: string;
  sceneId: string;
  entrance: string;
  exit: string;
  personnel: string[];
}

export interface RunSheet {
  version: string;
  issuedAt: string;
  note: string;
  scenes: RunSheetSceneFact[];
  cues: RunSheetCueFact[];
}

/** 字段级并列分歧：本地编排值 vs 换场单事实值，各自带来源版本。 */
export interface FieldConflict {
  field: CoreField;
  localValue: string;
  factValue: string;
  localBasis: string;
  factVersion: string;
  resolved: boolean;
}

export type ReceiptStatus = 'running' | 'failed' | 'completed';

/**
 * 一个换场单版本对应一个合并批次。
 * 处理粒度为提示：processedCueIds 记录已成功落地的提示，
 * 重试同一批时跳过这些 id，保证不重复生成提示。
 */
export interface MergeReceipt {
  batchId: string;
  version: string;
  status: ReceiptStatus;
  totalCues: number;
  processedCueIds: string[];
  pendingCueIds: string[];
  /** 受本次更新影响、需要重新核对的提示（新增 + 事实变化，仅未确认）。 */
  affectedCueIds: string[];
  /** 事实已更新但提示早已确认：保留旧依据，仅提示差异。 */
  staleConfirmedCueIds: string[];
  newCueIds: string[];
  sceneApplied: boolean;
  callsApplied: boolean;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface RunSheetState {
  latest: RunSheet | null;
  history: RunSheet[];
  receipt: MergeReceipt | null;
  receipts: MergeReceipt[];
}

export interface WorkspaceState {
  show: ShowData;
  versions: import('stage-cue-editor/models/show').VersionSnapshot[];
  runSheet: RunSheetState;
}

export const FACT_BASIS_LOCAL = 'local-confirmed';

/* ---------------------------------- 工具 ---------------------------------- */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function fieldDisplay(field: CoreField, value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join('、') : '—';
  if (field === 'duration') return Number(value) > 0 ? `${value} 秒` : '—';
  return value === undefined || value === null || value === ''
    ? '—'
    : String(value);
}

/** 归一化核心字段值用于「是否一致」比较（数组忽略顺序与空白）。 */
export function normalizeFieldValue(field: CoreField, value: unknown): string {
  if (Array.isArray(value))
    return value
      .map((item) => String(item).trim())
      .filter(Boolean)
      .sort()
      .join('|');
  if (field === 'duration') return String(Number(value) || 0);
  return String(value ?? '').trim();
}

export function factOf(cue: RunSheetCueFact, field: CoreField): unknown {
  return cue[field];
}

export function findFact(
  sheet: RunSheet,
  cueId: string,
): RunSheetCueFact | undefined {
  return sheet.cues.find((item) => item.cueId === cueId);
}

/** 依据标记的展示文本：换场单版本显示版本号，本地确认依据显示中文说明。 */
export function basisLabel(value: string | undefined): string {
  if (!value) return '本地编排';
  if (value === FACT_BASIS_LOCAL) return '本地确认';
  return `换场单 ${value}`;
}

export function findCue(
  show: ShowData,
  cueId: string,
): { cue: Cue; scene: Scene } | undefined {
  for (const scene of show.scenes) {
    const cue = scene.cues.find((item) => item.id === cueId);
    if (cue) return { cue, scene };
  }
  return undefined;
}

/** 计算一条提示相对某版换场单的字段级分歧；未解析决定或本地值与事实不同即视为待处理。 */
export function conflictsForCue(
  cue: Cue,
  sheet: RunSheet | null,
): FieldConflict[] {
  if (!sheet) return [];
  const fact = findFact(sheet, cue.id);
  if (!fact) return [];
  return CORE_FIELDS.flatMap((field) => {
    const localRaw = cue[field];
    const factRaw = factOf(fact, field);
    const same =
      normalizeFieldValue(field, localRaw) ===
      normalizeFieldValue(field, factRaw);
    const resolved = cue.resolvedAgainst?.[field] === sheet.version;
    if (same || resolved) return [];
    return [
      {
        field,
        localValue: fieldDisplay(field, localRaw),
        factValue: fieldDisplay(field, factRaw),
        localBasis: basisLabel(cue.factBasis?.[field]),
        factVersion: sheet.version,
        resolved,
      },
    ];
  });
}

/* -------------------------------- 合并计划 -------------------------------- */

export interface MergePlan {
  affected: string[];
  staleConfirmed: string[];
  newCueIds: string[];
  changedExisting: string[];
}

function factCoreSignature(cue: RunSheetCueFact): string {
  return CORE_FIELDS.map((field) =>
    normalizeFieldValue(field, factOf(cue, field)),
  ).join('');
}

/** 对比上一版与新版：哪些提示的核心事实发生了变化（含上下场/人员安排变化）。 */
export function planMerge(
  previous: RunSheet | null,
  next: RunSheet,
  show: ShowData,
): MergePlan {
  const affected = new Set<string>();
  const staleConfirmed = new Set<string>();
  const newCueIds: string[] = [];
  const changedExisting: string[] = [];

  const markChanged = (cueId: string, confirmed: boolean): void => {
    changedExisting.push(cueId);
    // 已确认内容保留旧依据，仅列入「新版事实」提示；未确认则重新核对。
    if (confirmed) staleConfirmed.add(cueId);
    else affected.add(cueId);
  };

  next.cues.forEach((fact) => {
    const local = findCue(show, fact.cueId);
    if (!local) {
      // 本地尚不存在的事实提示：一律进入核对队列
      newCueIds.push(fact.cueId);
      affected.add(fact.cueId);
      return;
    }
    const oldFact = previous ? findFact(previous, fact.cueId) : undefined;
    if (oldFact) {
      const changed =
        factCoreSignature(oldFact) !== factCoreSignature(fact) ||
        oldFact.entrance !== fact.entrance ||
        oldFact.exit !== fact.exit ||
        [...oldFact.personnel].sort().join('|') !==
          [...fact.personnel].sort().join('|');
      if (changed) markChanged(fact.cueId, Boolean(local.cue.confirmed));
      return;
    }
    if (previous) {
      // 中间版本里没有该提示：视为新版新增到既有本地提示
      markChanged(fact.cueId, Boolean(local.cue.confirmed));
      return;
    }
    // 首次接收（无历史换场单）：只按本地值与事实是否一致判断，
    // 已确认且一致的旧数据不需要核对，也不算「事实更新」。
    const differs = CORE_FIELDS.some(
      (field) =>
        normalizeFieldValue(field, local.cue[field]) !==
        normalizeFieldValue(field, factOf(fact, field)),
    );
    if (differs) markChanged(fact.cueId, Boolean(local.cue.confirmed));
  });

  return {
    affected: [...affected],
    staleConfirmed: [...staleConfirmed],
    newCueIds,
    changedExisting,
  };
}

/* ------------------------------ 批次状态构造 ------------------------------ */

export function createReceipt(
  sheet: RunSheet,
  plan: MergePlan,
  now: string,
): MergeReceipt {
  return {
    batchId: `batch-${sheet.version}`,
    version: sheet.version,
    status: 'running',
    totalCues: sheet.cues.length,
    processedCueIds: [],
    pendingCueIds: sheet.cues.map((item) => item.cueId),
    affectedCueIds: plan.affected,
    staleConfirmedCueIds: plan.staleConfirmed,
    newCueIds: plan.newCueIds,
    sceneApplied: false,
    callsApplied: false,
    startedAt: now,
  };
}

export function resumeReceipt(receipt: MergeReceipt): MergeReceipt {
  return { ...receipt, status: 'running', error: undefined };
}

/* -------------------------------- 逐步合并 -------------------------------- */

/**
 * 应用场次事实：补齐换场单中的场次、同步场次结构并按换场单顺序排列。
 * 本地多出的场次保留在末尾（编排层资产不被删除）。幂等。
 */
export function applySceneFacts(show: ShowData, sheet: RunSheet): ShowData {
  const next = clone(show);
  const byId = new Map(next.scenes.map((scene) => [scene.id, scene]));
  const ordered: Scene[] = [];
  sheet.scenes.forEach((fact) => {
    const existing = byId.get(fact.id);
    if (existing) {
      existing.act = fact.act;
      existing.name = fact.name;
      existing.title = fact.title;
      existing.startTime = fact.startTime;
      existing.source = 'runsheet';
      ordered.push(existing);
      byId.delete(fact.id);
    } else {
      ordered.push({
        id: fact.id,
        act: fact.act,
        name: fact.name,
        title: fact.title,
        startTime: fact.startTime,
        locked: false,
        cues: [],
        source: 'runsheet',
      });
    }
  });
  byId.forEach((scene) => ordered.push(scene));
  next.scenes = ordered;
  return next;
}

/** 从换场单事实生成上下场与人员到场记录。幂等（同版本覆盖）。 */
export function buildCalls(sheet: RunSheet): CallRecord[] {
  return sheet.cues.map((fact, index) => ({
    id: `call-${sheet.version}-${fact.cueId}-${index}`,
    cueId: fact.cueId,
    sceneId: fact.sceneId,
    entrance: fact.entrance,
    exit: fact.exit,
    personnel: [...fact.personnel],
  }));
}

function recalculate(scene: Scene): void {
  let elapsed = 0;
  scene.cues.forEach((item) => {
    item.offset = elapsed;
    elapsed += Number(item.duration) || 0;
  });
}

/**
 * 处理单条提示事实：
 * - 新提示：按事实生成，追加到对应场次末尾，未确认，进入核对队列；
 * - 已存在：仅在本地尚无该版本依据时记录新依据版本，绝不覆盖本地值；
 *   已确认提示完全保留旧依据。
 * 重试时已处理的 cueId 由调用方跳过，保证幂等不重复。
 */
export function processCueFact(
  show: ShowData,
  sheet: RunSheet,
  cueId: string,
  now: string,
): ShowData {
  const fact = findFact(sheet, cueId);
  if (!fact) return show;
  const existing = findCue(show, cueId);
  if (existing) {
    const next = clone(show);
    const local = findCue(next, cueId);
    if (local && !local.cue.confirmed) {
      CORE_FIELDS.forEach((field) => {
        if (!local.cue.factBasis?.[field]) {
          local.cue.factBasis = {
            ...local.cue.factBasis,
            [field]: sheet.version,
          };
        }
      });
      local.cue.origin = 'runsheet';
    }
    return next;
  }

  const next = clone(show);
  let scene = next.scenes.find((item) => item.id === fact.sceneId);
  if (!scene) {
    scene = {
      id: fact.sceneId,
      act: fact.sceneId,
      name: fact.sceneId,
      title: fact.sceneId,
      startTime: '19:30',
      locked: false,
      cues: [],
      source: 'runsheet',
    };
    next.scenes.push(scene);
  }
  const created: Cue = {
    id: fact.cueId,
    kind: fact.kind,
    title: fact.title,
    duration: fact.duration,
    owner: fact.owner,
    lighting: fact.lighting,
    sound: fact.sound,
    props: [...fact.props],
    cast: [...fact.cast],
    notes: '',
    dependsOn: [],
    offset: 0,
    origin: 'runsheet',
    confirmed: false,
    confirmedAt: undefined,
    factBasis: CORE_FIELDS.reduce(
      (basis, field) => ({ ...basis, [field]: sheet.version }),
      {} as Partial<Record<CoreField, string>>,
    ),
    resolvedAgainst: {},
  };
  scene.cues.push(created);
  recalculate(scene);
  next.updatedAt = now;
  return next;
}

/** 推进一批未处理的提示，返回更新后的 show 与回执。 */
export function advanceBatch(
  show: ShowData,
  sheet: RunSheet,
  receipt: MergeReceipt,
  now: string,
  limit = Number.POSITIVE_INFINITY,
): { show: ShowData; receipt: MergeReceipt } {
  let working = show;
  const processed = new Set(receipt.processedCueIds);
  let taken = 0;
  for (const cueId of receipt.pendingCueIds) {
    if (processed.has(cueId)) continue;
    working = processCueFact(working, sheet, cueId, now);
    processed.add(cueId);
    taken += 1;
    if (taken >= limit) break;
  }
  const processedCueIds = sheet.cues
    .map((item) => item.cueId)
    .filter((id) => processed.has(id));
  const pendingCueIds = sheet.cues
    .map((item) => item.cueId)
    .filter((id) => !processed.has(id));
  const done = pendingCueIds.length === 0;
  const nextReceipt: MergeReceipt = {
    ...receipt,
    processedCueIds,
    pendingCueIds,
    status: done ? 'completed' : 'running',
    finishedAt: done ? now : receipt.finishedAt,
  };
  return { show: working, receipt: nextReceipt };
}

export function failReceipt(
  receipt: MergeReceipt,
  message: string,
): MergeReceipt {
  return { ...receipt, status: 'failed', error: message };
}

/* ------------------------------ 核对期人工决定 ----------------------------- */

/** 采用换场单事实：覆盖的是本地编排值，但这是显式人工动作，非自动覆盖。 */
export function adoptFact(
  show: ShowData,
  cueId: string,
  field: CoreField,
  sheet: RunSheet,
  now: string,
): ShowData {
  const fact = findFact(sheet, cueId);
  if (!fact) return show;
  const next = clone(show);
  const found = findCue(next, cueId);
  if (!found) return show;
  const value = factOf(fact, field);
  if (field === 'props' || field === 'cast') {
    found.cue[field] = [...(value as string[])];
  } else if (field === 'duration') {
    found.cue.duration = Number(value) || 0;
  } else if (field === 'kind') {
    found.cue.kind = value as CueKind;
  } else {
    found.cue[field] = String(value ?? '');
  }
  found.cue.factBasis = { ...found.cue.factBasis, [field]: sheet.version };
  found.cue.resolvedAgainst = {
    ...found.cue.resolvedAgainst,
    [field]: sheet.version,
  };
  next.updatedAt = now;
  const scene = next.scenes.find((item) => item.id === found.scene.id);
  if (scene) recalculate(scene);
  return next;
}

/** 保留本地编排值：记录该决定针对的换场单版本，分歧消失但依据留痕。 */
export function keepLocal(
  show: ShowData,
  cueId: string,
  field: CoreField,
  sheet: RunSheet,
  now: string,
): ShowData {
  const next = clone(show);
  const found = findCue(next, cueId);
  if (!found) return show;
  found.cue.resolvedAgainst = {
    ...found.cue.resolvedAgainst,
    [field]: sheet.version,
  };
  next.updatedAt = now;
  return next;
}

/** 确认提示：以当前换场单版本固化全部依据，离开重新核对队列。 */
export function confirmCue(
  show: ShowData,
  cueId: string,
  sheet: RunSheet | null,
  now: string,
): ShowData {
  const next = clone(show);
  const found = findCue(next, cueId);
  if (!found) return show;
  const version = sheet?.version ?? FACT_BASIS_LOCAL;
  found.cue.confirmed = true;
  found.cue.confirmedAt = now;
  if (sheet && findFact(sheet, cueId)) {
    found.cue.factBasis = CORE_FIELDS.reduce(
      (basis, field) => ({
        ...basis,
        [field]: found.cue.resolvedAgainst?.[field] ?? version,
      }),
      { ...found.cue.factBasis } as Partial<Record<CoreField, string>>,
    );
    found.cue.resolvedAgainst = CORE_FIELDS.reduce(
      (basis, field) => ({ ...basis, [field]: version }),
      {} as Partial<Record<CoreField, string>>,
    );
  }
  next.updatedAt = now;
  return next;
}

/** 把提示重新打开核对（例如已确认提示出现新版事实、舞台监督主动复审）。 */
export function reopenCue(
  show: ShowData,
  cueId: string,
  now: string,
): ShowData {
  const next = clone(show);
  const found = findCue(next, cueId);
  if (!found) return show;
  found.cue.confirmed = false;
  found.cue.confirmedAt = undefined;
  next.updatedAt = now;
  return next;
}

/** 旧数据没有来源标记：按本地确认处理。 */
export function localConfirmedBasis(): Partial<Record<CoreField, string>> {
  return CORE_FIELDS.reduce(
    (basis, field) => ({ ...basis, [field]: FACT_BASIS_LOCAL }),
    {} as Partial<Record<CoreField, string>>,
  );
}

export function migrateLegacyShow(show: ShowData): ShowData {
  const next = clone(show);
  next.scenes.forEach((scene) => {
    if (!scene.source) scene.source = 'local';
    scene.cues.forEach((cue) => {
      if (!cue.origin) {
        cue.origin = 'local';
        cue.confirmed = true;
        cue.factBasis = localConfirmedBasis();
        cue.resolvedAgainst = {};
      }
    });
  });
  return next;
}
