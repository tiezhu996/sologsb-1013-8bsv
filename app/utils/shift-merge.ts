import type {
  Cue,
  CueConflict,
  MergeSession,
  Scene,
  ShiftSheetBatch,
  ShiftSheetEntry,
  ShowData,
} from '../models/show';

/**
 * 换场单合并引擎（纯函数，不依赖 Ember）。
 *
 * 状态所有权：
 * - 换场单只提供事实：场次顺序、上下场、人员到场；
 * - 本地提示表负责编排：灯光、音响、道具、时长、负责人、备注、提示顺序。
 * 合并只写事实字段；核心字段（上下场 / 人员）分歧时并列保留为冲突记录，
 * 绝不自动覆盖本地值。已确认提示保留旧依据，只有受影响的未确认提示
 * 按新修订重新核对。
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function localConfirmed(): Cue['confirmation'] {
  return { status: 'confirmed', source: 'local', basisRevision: null };
}

/**
 * 旧数据迁移：没有来源标记 / 确认状态的提示，一律按本地已确认处理；
 * 缺少上下场字段的补空串。
 */
export function migrateShow(show: ShowData): ShowData {
  show.scenes.forEach((scene) => {
    scene.cues.forEach((item) => {
      if (typeof item.entrance !== 'string') item.entrance = '';
      if (!item.confirmation || !item.confirmation.source) {
        item.confirmation = localConfirmed();
      }
    });
  });
  return show;
}

/**
 * 模拟后台离线整理后带回的换场单批次（纯前端演示数据源）。
 * 奇数修订与偶数修订交替，覆盖：场次顺序、上下场、人员到场、
 * 新建提示、核心字段分歧，以及首批发一条坏数据用于演示断点续合并。
 */
export function buildSampleBatch(
  revision: number,
  show: ShowData,
): ShiftSheetBatch {
  const tag = `R${revision}`;
  const sceneIds = show.scenes.map((scene) => scene.id);
  const first = sceneIds[0] ?? 'scene-1';
  const second = sceneIds[1] ?? first;
  // 场次顺序可能已被上一批复位：按提示实际所在场次定位，避免指错场次
  const hostOf = (cueId: string) =>
    show.scenes.find((scene) => scene.cues.some((item) => item.id === cueId))
      ?.id ?? first;
  const entries: ShiftSheetEntry[] = [];
  if (revision % 2 === 1) {
    entries.push(
      {
        id: `${tag}-order`,
        type: 'scene-order',
        sceneId: '',
        order: [...sceneIds].reverse(),
      },
      {
        id: `${tag}-ent-1`,
        type: 'entrance',
        sceneId: hostOf('cue-actor-1'),
        cueId: 'cue-actor-1',
        entrance: '左台入 · 台中下',
      },
      {
        id: `${tag}-arr-1`,
        type: 'arrival',
        sceneId: hostOf('cue-actor-2'),
        cueId: 'cue-actor-2',
        arrival: ['群演 6 人', '侍女 4 人', '太监 2 人'],
      },
      {
        id: `${tag}-new-1`,
        type: 'arrival',
        sceneId: second,
        create: { kind: '演员', title: '太监总管宣旨入场' },
        arrival: ['太监总管／王珮'],
      },
    );
    if (revision === 1) {
      entries.push({
        id: `${tag}-bad-1`,
        type: 'arrival',
        sceneId: 'scene-backstage-99',
        cueId: 'cue-none',
        arrival: ['数据待补'],
      });
    }
  } else {
    const createdId = `cue-R${revision - 1}-new-1`;
    entries.push(
      { id: `${tag}-order`, type: 'scene-order', sceneId: '', order: sceneIds },
      {
        id: `${tag}-ent-1`,
        type: 'entrance',
        sceneId: hostOf(createdId),
        cueId: createdId,
        entrance: '右台入 · 左台下',
      },
      {
        id: `${tag}-arr-1`,
        type: 'arrival',
        sceneId: hostOf('cue-actor-1'),
        cueId: 'cue-actor-1',
        arrival: ['说书人／周启', '琴师／林榭'],
      },
    );
  }
  return { id: `batch-${tag}`, revision, entries };
}

export interface MergeStepResult {
  session: MergeSession;
  show: ShowData;
  conflicts: CueConflict[];
  applied: boolean;
  done: boolean;
}

/**
 * 推进合并会话一步：
 * - 游标越界 → 批次完成；
 * - 已回执条目 → 直接跳过（重试同一批不重复生成提示）；
 * - 应用失败 → 状态置 failed，进度与成功回执原样保留。
 * 每步结果都应立即持久化，页面关掉再打开可从游标接着处理。
 */
export function stepMerge(
  session: MergeSession,
  batch: ShiftSheetBatch,
  show: ShowData,
  conflicts: CueConflict[],
): MergeStepResult {
  const entry = batch.entries[session.cursor];
  if (!entry) {
    return {
      session: { ...session, status: 'done' },
      show,
      conflicts,
      applied: false,
      done: true,
    };
  }
  if (session.receipts[entry.id]) {
    return {
      session: { ...session, cursor: session.cursor + 1 },
      show,
      conflicts,
      applied: false,
      done: false,
    };
  }
  try {
    const applied = applyEntryToShow(show, conflicts, entry, batch.revision);
    return {
      session: {
        ...session,
        cursor: session.cursor + 1,
        receipts: { ...session.receipts, [entry.id]: 'applied' },
      },
      show: applied.show,
      conflicts: applied.conflicts,
      applied: true,
      done: false,
    };
  } catch (error) {
    return {
      session: {
        ...session,
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
      },
      show,
      conflicts,
      applied: false,
      done: false,
    };
  }
}

/**
 * 应用单条换场单事实（纯函数，返回新 show / conflicts）。
 * 只写事实字段（场次顺序 / 上下场 / 人员到场），本地编排字段一概不碰。
 * 先校验后落写，单条原子：失败条目不会产生半截数据。
 */
export function applyEntryToShow(
  show: ShowData,
  conflicts: CueConflict[],
  entry: ShiftSheetEntry,
  revision: number,
): { show: ShowData; conflicts: CueConflict[] } {
  const next = clone(show);
  let nextConflicts = conflicts;
  if (entry.type === 'scene-order') {
    const order = entry.order ?? [];
    if (!order.length) throw new Error(`换场单条目 ${entry.id} 的场次顺序为空`);
    const known = new Set(next.scenes.map((scene) => scene.id));
    const ranked = order.filter((id) => known.has(id));
    next.scenes.sort((a, b) => {
      const ai = ranked.indexOf(a.id);
      const bi = ranked.indexOf(b.id);
      return (
        (ai === -1 ? ranked.length : ai) - (bi === -1 ? ranked.length : bi)
      );
    });
  } else {
    const scene = next.scenes.find((item) => item.id === entry.sceneId);
    if (!scene)
      throw new Error(
        `换场单条目 ${entry.id} 指向不存在的场次 ${entry.sceneId}`,
      );
    const createdId = `cue-${entry.id}`;
    let target =
      (entry.cueId
        ? scene.cues.find((item) => item.id === entry.cueId)
        : undefined) ?? scene.cues.find((item) => item.id === createdId);
    if (!target) {
      if (!entry.create) {
        throw new Error(
          `换场单条目 ${entry.id} 指向不存在的提示 ${entry.cueId ?? '(未指定)'}`,
        );
      }
      target = {
        id: createdId,
        kind: entry.create.kind,
        title: entry.create.title,
        duration: 30,
        owner: '',
        lighting: '',
        sound: '',
        props: [],
        cast: [],
        notes: '由换场单下发生成',
        dependsOn: [],
        offset: 0,
        entrance: '',
        confirmation: {
          status: 'pending',
          source: 'shift-sheet',
          basisRevision: revision,
        },
      };
      scene.cues.push(target);
    }
    if (entry.type === 'entrance') {
      nextConflicts = reconcileField(
        nextConflicts,
        scene,
        target,
        'entrance',
        entry.entrance ?? '',
        revision,
      );
    } else if (entry.type === 'arrival') {
      nextConflicts = reconcileField(
        nextConflicts,
        scene,
        target,
        'cast',
        (entry.arrival ?? []).join('、'),
        revision,
      );
    }
    recalculateScene(scene);
  }
  next.updatedAt = new Date().toISOString();
  return { show: next, conflicts: nextConflicts };
}

/**
 * 核心字段对账：本地空缺 → 采用下发事实；一致 → 不动；
 * 分歧 → 并列保留为冲突记录，本地值不被覆盖。
 */
function reconcileField(
  conflicts: CueConflict[],
  scene: Scene,
  target: Cue,
  field: 'entrance' | 'cast',
  incoming: string,
  revision: number,
): CueConflict[] {
  if (!incoming) return conflicts;
  markAffected(target, revision);
  const localValue =
    field === 'cast' ? target.cast.join('、') : target.entrance;
  if (!localValue) {
    if (field === 'cast') {
      target.cast = incoming
        .split(/[、,，]/)
        .map((value) => value.trim())
        .filter(Boolean);
    } else {
      target.entrance = incoming;
    }
    return conflicts;
  }
  if (localValue === incoming) return conflicts;
  const existing = conflicts.find(
    (entry) =>
      entry.status === 'open' &&
      entry.cueId === target.id &&
      entry.field === field,
  );
  if (existing) {
    return conflicts.map((entry) =>
      entry === existing
        ? { ...entry, localValue, incomingValue: incoming, revision }
        : entry,
    );
  }
  return [
    ...conflicts,
    {
      id: uid('conflict'),
      sceneId: scene.id,
      cueId: target.id,
      field,
      localValue,
      incomingValue: incoming,
      revision,
      status: 'open',
    },
  ];
}

/**
 * 换场单更新后：只让受影响的未确认提示按新修订重新核对；
 * 已确认提示保留旧依据，一概不动。
 */
function markAffected(target: Cue, revision: number): void {
  if (target.confirmation.status === 'pending') {
    target.confirmation = { ...target.confirmation, basisRevision: revision };
  }
}

/**
 * 人工取舍冲突：采用下发值则写入对应字段，保留本地值则不动；
 * 取舍即完成核对，提示转为已确认并以引发分歧的修订为依据。
 */
export function resolveConflictInShow(
  show: ShowData,
  conflict: CueConflict,
  choice: 'local' | 'incoming',
): ShowData {
  const next = clone(show);
  const scene = next.scenes.find((item) => item.id === conflict.sceneId);
  const target = scene?.cues.find((item) => item.id === conflict.cueId);
  if (target) {
    if (choice === 'incoming') {
      if (conflict.field === 'cast') {
        target.cast = conflict.incomingValue
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean);
      } else {
        target.entrance = conflict.incomingValue;
      }
    }
    target.confirmation = {
      ...target.confirmation,
      status: 'confirmed',
      basisRevision: conflict.revision,
    };
    next.updatedAt = new Date().toISOString();
  }
  return next;
}

/** 核对确认：待核对提示转为已确认，依据保留其待核对修订。 */
export function confirmCueInShow(
  show: ShowData,
  cueId: string,
  fallbackRevision: number,
): ShowData {
  const found = show.scenes
    .flatMap((scene) => scene.cues)
    .find((item) => item.id === cueId);
  if (!found || found.confirmation.status !== 'pending') return show;
  const next = clone(show);
  const target = next.scenes
    .flatMap((scene) => scene.cues)
    .find((item) => item.id === cueId);
  if (target) {
    target.confirmation = {
      ...target.confirmation,
      status: 'confirmed',
      basisRevision:
        target.confirmation.basisRevision ?? (fallbackRevision || null),
    };
    next.updatedAt = new Date().toISOString();
  }
  return next;
}

function recalculateScene(scene: Scene): void {
  let elapsed = 0;
  scene.cues.forEach((item) => {
    item.offset = elapsed;
    elapsed += Number(item.duration) || 0;
  });
}
