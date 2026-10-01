import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import type {
  Cue,
  CueConflict,
  CueDraft,
  CueIssue,
  CueKind,
  MergeSession,
  PersistedState,
  Scene,
  ShiftSheetBatch,
  ShowData,
  VersionDiff,
  VersionSnapshot,
} from 'stage-cue-editor/models/show';
import { CUE_KINDS, OWNERS } from 'stage-cue-editor/models/show';
import {
  buildSampleBatch,
  confirmCueInShow,
  localConfirmed,
  migrateShow,
  resolveConflictInShow,
  stepMerge,
} from 'stage-cue-editor/utils/shift-merge';

const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function revisionLabel(revision: number | null | undefined): string {
  return revision ? `R${revision}` : '本地';
}

function cue(
  id: string,
  kind: CueKind,
  title: string,
  duration: number,
  owner: string,
  extra: Partial<Cue> = {},
): Cue {
  return {
    id,
    kind,
    title,
    duration,
    owner,
    lighting: '',
    sound: '',
    props: [],
    cast: [],
    notes: '',
    dependsOn: [],
    offset: 0,
    entrance: '',
    confirmation: localConfirmed(),
    ...extra,
  };
}

function initialShow(): ShowData {
  const scenes: Scene[] = [
    {
      id: 'scene-1',
      act: '第一幕',
      name: 'S1',
      title: '月下序场',
      startTime: '19:30',
      locked: false,
      cues: [
        cue('cue-light-1', '灯光', '观众席渐暗 · 面光起', 45, '李岚', {
          lighting: 'FOH 1 号面光 65%，侧光暖白 40%',
          notes: '开演铃后 10 秒执行',
        }),
        cue('cue-actor-1', '演员', '说书人自左台入场', 90, '赵一帆', {
          cast: ['说书人／周启'],
          props: ['折扇'],
          entrance: '左台入场 · 原地下场',
          notes: '追光跟随；入场后停留台中',
        }),
        cue('cue-sound-1', '音响', '古琴引子淡入', 120, '陈默', {
          sound: 'Q1 古琴引子，-18dB 淡入 6 秒',
          dependsOn: ['cue-deleted-old'],
          notes: '旧版依赖保留用于检查示例',
        }),
        cue('cue-prop-1', '道具', '月牙灯升至舞台中线', 75, '孙禾', {
          props: ['月牙灯'],
          lighting: '顶排 3 号定点',
        }),
      ],
    },
    {
      id: 'scene-2',
      act: '第一幕',
      name: 'S2',
      title: '宫门夜宴',
      startTime: '19:40',
      locked: false,
      cues: [
        cue('cue-stage-2', '舞台', '中景屏风换为朱红', 60, '', {
          notes: '负责人尚未确认',
        }),
        cue('cue-actor-2', '演员', '群臣列队入场', 110, '赵一帆', {
          cast: ['群演 6 人', '侍女 4 人'],
          props: ['宫灯'],
        }),
        cue('cue-light-2', '灯光', '暖金顶光覆盖后区', 80, '李岚', {
          lighting: '顶光 4、5 号 70%，色温 3200K',
        }),
      ],
    },
  ];
  scenes.forEach((scene) => recalculateScene(scene));
  return {
    title: '《长夜行》首演提示表',
    venue: '实验剧场 A 厅',
    date: '2026-10-18',
    scenes,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 旧数据迁移在 utils/shift-merge 的 migrateShow 中完成：
 * 没有来源标记的提示一律按本地已确认处理。
 */
function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { show: initialShow(), versions: [] };
    const parsed = JSON.parse(raw) as PersistedState;
    return {
      show: migrateShow(parsed.show ?? initialShow()),
      versions: parsed.versions ?? [],
      conflicts: parsed.conflicts ?? [],
      mergeSession: parsed.mergeSession ?? null,
      incomingBatch: parsed.incomingBatch ?? null,
      shiftRevision: parsed.shiftRevision ?? 0,
    };
  } catch {
    return { show: initialShow(), versions: [] };
  }
}

function recalculateScene(scene: Scene): void {
  let elapsed = 0;
  scene.cues.forEach((item) => {
    item.offset = elapsed;
    elapsed += Number(item.duration) || 0;
  });
}

function startSeconds(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 3600 + Number(minute) * 60;
}

function timeLabel(scene: Scene, offset: number): string {
  const total = startSeconds(scene.startTime) + offset;
  const hour = Math.floor((total % 86400) / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  return [hour, minute, second]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function overlaps(
  aStart: number,
  aDuration: number,
  bStart: number,
  bDuration: number,
): boolean {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

export default class CueEditorComponent extends Component {
  private static persisted: PersistedState = loadState();

  @tracked show: ShowData = CueEditorComponent.persisted.show;
  @tracked versions: VersionSnapshot[] =
    CueEditorComponent.persisted.versions ?? [];
  @tracked conflicts: CueConflict[] =
    CueEditorComponent.persisted.conflicts ?? [];
  @tracked mergeSession: MergeSession | null =
    CueEditorComponent.persisted.mergeSession ?? null;
  @tracked incomingBatch: ShiftSheetBatch | null =
    CueEditorComponent.persisted.incomingBatch ?? null;
  @tracked shiftRevision: number =
    CueEditorComponent.persisted.shiftRevision ?? 0;
  @tracked activeSceneId = this.show.scenes[0]?.id ?? '';
  @tracked selectedCueId = this.show.scenes[0]?.cues[0]?.id ?? '';
  @tracked draft: CueDraft | null = null;
  @tracked compareVersionId = '';
  @tracked message = '';
  @tracked search = '';

  private undoStack: ShowData[] = [];
  private redoStack: ShowData[] = [];
  private dragCueId = '';
  private mergeTimer: number | null = null;

  constructor(owner: unknown, args: Record<string, unknown>) {
    super(owner, args);
    window.addEventListener('keydown', this.handleKeyboard);
    // 页面中途关掉再打开：检测到未完成的批次会话，从上次游标接着处理
    if (this.mergeSession?.status === 'active' && this.incomingBatch) {
      this.mergeTimer = window.setTimeout(this.processMergeStep, 500);
    }
  }

  get activeScene(): Scene | undefined {
    return this.show.scenes.find((scene) => scene.id === this.activeSceneId);
  }

  get selectedCue(): Cue | undefined {
    return this.activeScene?.cues.find(
      (item) => item.id === this.selectedCueId,
    );
  }

  get cueRows() {
    if (!this.activeScene) return [];
    return this.activeScene.cues.map((item, index) => ({
      ...item,
      index,
      start: timeLabel(this.activeScene as Scene, item.offset),
      end: timeLabel(this.activeScene as Scene, item.offset + item.duration),
      selected: item.id === this.selectedCueId,
      hasIssue: this.issues.some((issue) => issue.cueId === item.id),
      pending: item.confirmation.status === 'pending',
      conflicted: this.conflicts.some(
        (entry) => entry.status === 'open' && entry.cueId === item.id,
      ),
      kindClass:
        item.kind === '灯光'
          ? 'light'
          : item.kind === '音响'
            ? 'sound'
            : item.kind === '道具'
              ? 'prop'
              : item.kind === '演员'
                ? 'cast'
                : item.kind === '字幕'
                  ? 'caption'
                  : 'stage',
      propsLabel: item.props.join('、'),
      castLabel: item.cast.join('、'),
    }));
  }

  get sceneRows() {
    return this.show.scenes.map((scene) => ({
      ...scene,
      active: scene.id === this.activeSceneId,
      issueCount: this.issues.filter((issue) => issue.sceneId === scene.id)
        .length,
      duration: scene.cues.reduce((total, item) => total + item.duration, 0),
    }));
  }

  get cueKindOptions(): CueKind[] {
    return CUE_KINDS;
  }

  get ownerOptions(): string[] {
    return OWNERS;
  }

  get allCues(): Array<{ cue: Cue; scene: Scene }> {
    return this.show.scenes.flatMap((scene) =>
      scene.cues.map((item) => ({ cue: item, scene })),
    );
  }

  get issues(): CueIssue[] {
    const issues: CueIssue[] = [];
    this.allCues.forEach(({ cue: item, scene }) => {
      if (!item.owner) {
        issues.push({
          id: `owner-${item.id}`,
          severity: 'error',
          title: '负责人空缺',
          detail: `${scene.act} ${scene.name}「${item.title}」尚未指定负责人。`,
          sceneId: scene.id,
          cueId: item.id,
        });
      }
      item.dependsOn.forEach((reference) => {
        if (!this.allCues.some((entry) => entry.cue.id === reference)) {
          issues.push({
            id: `ref-${item.id}-${reference}`,
            severity: 'error',
            title: '提示被引用但已删除',
            detail: `「${item.title}」仍依赖已删除的提示 ${reference}。`,
            sceneId: scene.id,
            cueId: item.id,
          });
        }
      });
      const previous = scene.cues[scene.cues.indexOf(item) - 1];
      if (previous && item.offset < previous.offset + previous.duration) {
        issues.push({
          id: `overlap-${item.id}`,
          severity: 'error',
          title: '同场时间冲突',
          detail: `「${item.title}」与上一条提示重叠。`,
          sceneId: scene.id,
          cueId: item.id,
        });
      }
      if (item.confirmation.status === 'pending') {
        issues.push({
          id: `pending-${item.id}`,
          severity: 'info',
          title: '待核对换场单',
          detail: `「${item.title}」需对照换场单 ${revisionLabel(item.confirmation.basisRevision)} 重新核对。`,
          sceneId: scene.id,
          cueId: item.id,
        });
      }
      const openConflict = this.conflicts.find(
        (entry) => entry.status === 'open' && entry.cueId === item.id,
      );
      if (openConflict) {
        issues.push({
          id: `conflict-${item.id}`,
          severity: 'warning',
          title: '换场单分歧待取舍',
          detail: `「${item.title}」的${openConflict.field === 'cast' ? '人员' : '上下场'}与下发值不一致，已并列保留。`,
          sceneId: scene.id,
          cueId: item.id,
        });
      }
    });

    const allCues = this.allCues;
    for (let index = 0; index < allCues.length; index += 1) {
      for (let next = index + 1; next < allCues.length; next += 1) {
        const left = allCues[index]!;
        const right = allCues[next]!;
        if (left.cue.id === right.cue.id || left.scene.id === right.scene.id)
          continue;
        const leftStart = startSeconds(left.scene.startTime) + left.cue.offset;
        const rightStart =
          startSeconds(right.scene.startTime) + right.cue.offset;
        if (
          !overlaps(
            leftStart,
            left.cue.duration,
            rightStart,
            right.cue.duration,
          )
        )
          continue;
        const sharedProps = left.cue.props.filter((value) =>
          right.cue.props.includes(value),
        );
        const sharedCast = left.cue.cast.filter((value) =>
          right.cue.cast.includes(value),
        );
        if (sharedProps.length) {
          issues.push({
            id: `prop-${left.cue.id}-${right.cue.id}`,
            severity: 'warning',
            title: '道具撞场',
            detail: `「${left.cue.title}」与「${right.cue.title}」同时使用：${sharedProps.join('、')}。`,
            sceneId: right.scene.id,
            cueId: right.cue.id,
          });
        }
        if (sharedCast.length) {
          issues.push({
            id: `cast-${left.cue.id}-${right.cue.id}`,
            severity: 'warning',
            title: '演员撞场',
            detail: `「${left.cue.title}」与「${right.cue.title}」同时需要：${sharedCast.join('、')}。`,
            sceneId: right.scene.id,
            cueId: right.cue.id,
          });
        }
      }
    }
    return issues.map((issue) => ({
      ...issue,
      icon: issue.severity === 'error' ? '!' : 'i',
    }));
  }

  get selectedProps(): string {
    return this.selectedCue?.props.join('、') ?? '';
  }

  get selectedCast(): string {
    return this.selectedCue?.cast.join('、') ?? '';
  }

  get errors(): number {
    return this.issues.filter((issue) => issue.severity === 'error').length;
  }

  get compareVersion(): VersionSnapshot | undefined {
    return this.versions.find(
      (version) => version.id === this.compareVersionId,
    );
  }

  get versionDiff(): VersionDiff[] {
    const version = this.compareVersion;
    if (!version) return [];
    const before = version.data.scenes.flatMap((scene) =>
      scene.cues.map(
        (item) =>
          `${scene.act}/${scene.name} · ${item.title} | ${item.owner || '未指定'} | ${item.duration}s`,
      ),
    );
    const after = this.show.scenes.flatMap((scene) =>
      scene.cues.map(
        (item) =>
          `${scene.act}/${scene.name} · ${item.title} | ${item.owner || '未指定'} | ${item.duration}s`,
      ),
    );
    return Array.from(
      { length: Math.max(before.length, after.length) },
      (_, index) => ({
        id: `diff-${index}`,
        changed: before[index] !== after[index],
        label: `提示 ${index + 1}`,
        before: before[index] ?? '—',
        after: after[index] ?? '—',
      }),
    );
  }

  get filteredScenes() {
    const term = this.search.trim().toLowerCase();
    return this.sceneRows.filter(
      (scene) =>
        !term ||
        `${scene.act}${scene.name}${scene.title}`.toLowerCase().includes(term),
    );
  }

  /* ---------------- 换场单合并：状态与派生数据 ---------------- */

  get shiftRevisionLabel(): string {
    return this.shiftRevision ? `换场单 R${this.shiftRevision}` : '尚未接收';
  }

  get receiveDisabled(): boolean {
    return Boolean(this.incomingBatch);
  }

  get canStartMerge(): boolean {
    return Boolean(this.incomingBatch) && !this.mergeSession;
  }

  get mergeActive(): boolean {
    return this.mergeSession?.status === 'active';
  }

  get mergeFailed(): boolean {
    return this.mergeSession?.status === 'failed';
  }

  get mergeProgress() {
    const session = this.mergeSession;
    if (!session) return null;
    const total =
      this.incomingBatch?.id === session.batchId
        ? this.incomingBatch.entries.length
        : session.cursor;
    return {
      batchId: session.batchId,
      revision: session.revision,
      current: Math.min(session.cursor, total),
      total,
      receipts: Object.keys(session.receipts).length,
      status: session.status,
    };
  }

  get openConflicts() {
    return this.conflicts
      .filter((entry) => entry.status === 'open')
      .map((entry) => {
        const found = this.allCues.find(
          ({ cue: item }) => item.id === entry.cueId,
        );
        return {
          ...entry,
          cueTitle: found?.cue.title ?? entry.cueId,
          sceneLabel: found
            ? `${found.scene.act} ${found.scene.name}`
            : '未知场次',
          fieldLabel: entry.field === 'cast' ? '人员到场 / 演员' : '上下场',
        };
      });
  }

  get pendingCues() {
    return this.allCues
      .filter(({ cue: item }) => item.confirmation.status === 'pending')
      .map(({ cue: item, scene }) => ({
        id: item.id,
        title: item.title,
        sceneLabel: `${scene.act} ${scene.name}`,
        basisLabel: `待核对 · 换场单 ${revisionLabel(item.confirmation.basisRevision)}`,
      }));
  }

  get selectedSourceLabel(): string {
    return this.selectedCue?.confirmation.source === 'shift-sheet'
      ? '换场单下发'
      : '本地编排';
  }

  get selectedIsShift(): boolean {
    return this.selectedCue?.confirmation.source === 'shift-sheet';
  }

  get selectedBasisLabel(): string {
    const confirmation = this.selectedCue?.confirmation;
    if (!confirmation) return '';
    if (confirmation.status === 'pending') {
      return `待核对 · 换场单 ${revisionLabel(confirmation.basisRevision)}`;
    }
    return confirmation.basisRevision
      ? `已确认 · 依据换场单 R${confirmation.basisRevision}`
      : '已确认 · 本地旧数据';
  }

  @action
  selectScene(id: string): void {
    this.activeSceneId = id;
    this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
    this.draft = null;
  }

  @action
  selectCue(id: string): void {
    this.selectedCueId = id;
    this.draft = null;
  }

  @action
  updateShowTitle(value: string): void {
    this.mutate((show) => {
      show.title = value;
    });
  }

  @action
  createCueDraft(kind: CueKind = '灯光'): void {
    if (this.activeScene?.locked) {
      this.notify('该场次已锁定，请先建立修订');
      return;
    }
    this.draft = {
      kind,
      title: '',
      duration: 60,
      owner: '',
      lighting: '',
      sound: '',
      props: '',
      cast: '',
      notes: '',
      dependsOn: '',
      entrance: '',
    };
  }

  @action
  cancelDraft(): void {
    this.draft = null;
  }

  @action
  editSelectedCue(): void {
    const item = this.selectedCue;
    if (!item || this.activeScene?.locked) return;
    this.draft = {
      id: item.id,
      kind: item.kind,
      title: item.title,
      duration: item.duration,
      owner: item.owner,
      lighting: item.lighting,
      sound: item.sound,
      props: item.props.join('、'),
      cast: item.cast.join('、'),
      notes: item.notes,
      dependsOn: item.dependsOn.join('、'),
      entrance: item.entrance,
    };
  }

  @action
  updateDraft<K extends keyof CueDraft>(field: K, value: CueDraft[K]): void {
    if (this.draft) this.draft = { ...this.draft, [field]: value };
  }

  @action
  saveDraft(): void {
    if (!this.draft || !this.draft.title.trim() || !this.activeScene) return;
    const draft = this.draft;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene) return;
      const existing = draft.id
        ? scene.cues.find((item) => item.id === draft.id)
        : undefined;
      const saved: Cue = {
        id: draft.id ?? uid('cue'),
        kind: draft.kind,
        title: draft.title.trim(),
        duration: Math.max(1, Number(draft.duration) || 1),
        owner: draft.owner,
        lighting: draft.lighting,
        sound: draft.sound,
        props: draft.props
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        cast: draft.cast
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        notes: draft.notes,
        dependsOn: draft.dependsOn
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        offset: 0,
        entrance: draft.entrance,
        // 编辑已有提示时保留确认状态与依据；本地新建的提示按本地已确认处理
        confirmation: existing?.confirmation ?? localConfirmed(),
      };
      const index = scene.cues.findIndex((item) => item.id === saved.id);
      if (index >= 0) scene.cues.splice(index, 1, saved);
      else scene.cues.push(saved);
      recalculateScene(scene);
      this.selectedCueId = saved.id;
    });
    this.draft = null;
  }

  @action
  removeCue(id: string): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene || scene.locked) return;
      scene.cues = scene.cues.filter((item) => item.id !== id);
      recalculateScene(scene);
    });
    this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
  }

  @action
  addScene(): void {
    const scene: Scene = {
      id: uid('scene'),
      act: `第${this.show.scenes.length + 1}幕`,
      name: `S${this.show.scenes.length + 1}`,
      title: '未命名场次',
      startTime: '20:00',
      locked: false,
      cues: [],
    };
    this.mutate((show) => show.scenes.push(scene));
    this.activeSceneId = scene.id;
    this.selectedCueId = '';
  }

  @action
  copyPreviousScene(): void {
    const index = this.show.scenes.findIndex(
      (scene) => scene.id === this.activeSceneId,
    );
    const previous = this.show.scenes[index - 1];
    if (!previous) {
      this.notify('当前已是第一场');
      return;
    }
    const copied: Scene = clone(previous);
    copied.id = uid('scene');
    copied.act = this.activeScene?.act ?? copied.act;
    copied.name = `${copied.name}-副本`;
    copied.title = `${copied.title}（复制）`;
    copied.cues = copied.cues.map((item) => ({
      ...item,
      id: uid('cue'),
      dependsOn: [],
    }));
    recalculateScene(copied);
    this.mutate((show) => show.scenes.splice(index + 1, 0, copied));
    this.activeSceneId = copied.id;
    this.selectedCueId = copied.cues[0]?.id ?? '';
    this.notify('已复制上一场流程');
  }

  @action
  updateSceneField(
    field: 'title' | 'startTime' | 'act' | 'name',
    value: string,
  ): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (scene && !scene.locked) scene[field] = value;
    });
  }

  @action
  updateSelectedField(field: keyof Cue, value: unknown): void {
    const id = this.selectedCueId;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      const item = scene?.cues.find((entry) => entry.id === id);
      if (!scene || !item || scene.locked) return;
      if (field === 'duration') item.duration = Math.max(1, Number(value) || 1);
      else if (field === 'props' || field === 'cast')
        item[field] = String(value)
          .split(/[、,，]/)
          .map((entry) => entry.trim())
          .filter(Boolean);
      else Object.assign(item, { [field]: value });
      recalculateScene(scene);
    });
  }

  @action
  moveSelected(direction: -1 | 1): void {
    const cues = this.activeScene?.cues ?? [];
    const from = cues.findIndex((item) => item.id === this.selectedCueId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= cues.length) return;
    this.moveCue(cues[from]!.id, cues[to]!.id);
  }

  @action
  startDrag(id: string): void {
    this.dragCueId = id;
  }

  @action
  allowDrop(event: DragEvent): boolean {
    event.preventDefault();
    return false;
  }

  @action
  dropOn(id: string): void {
    if (this.dragCueId) this.moveCue(this.dragCueId, id);
    this.dragCueId = '';
  }

  @action
  moveCue(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene || scene.locked) return;
      const from = scene.cues.findIndex((item) => item.id === sourceId);
      const to = scene.cues.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = scene.cues.splice(from, 1);
      scene.cues.splice(to, 0, moved!);
      recalculateScene(scene);
    });
    this.selectedCueId = sourceId;
    this.notify('顺序已更新，后续提示时间自动顺延');
  }

  @action
  lockVersion(): void {
    const snapshot: VersionSnapshot = {
      id: uid('version'),
      name: `锁定版 ${this.versions.length + 1}`,
      createdAt: new Date().toISOString(),
      data: clone(this.show),
    };
    this.versions = [snapshot, ...this.versions];
    this.compareVersionId = snapshot.id;
    this.persist();
    this.notify('已锁定当前版本');
  }

  @action
  createRevision(): void {
    this.mutate((show) =>
      show.scenes.forEach((scene) => {
        scene.locked = false;
      }),
    );
    this.notify('已从当前锁定版建立可编辑修订');
  }

  @action
  toggleSceneLock(): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (scene) scene.locked = !scene.locked;
    });
  }

  @action
  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.show));
    this.show = previous;
    this.ensureSelection();
    this.persist();
  }

  @action
  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.show));
    this.show = next;
    this.ensureSelection();
    this.persist();
  }

  @action
  setSearch(value: string): void {
    this.search = value;
  }

  @action
  selectCompareVersion(version: VersionSnapshot): void {
    this.compareVersionId = version.id;
  }

  /* ---------------- 换场单合并：接收、合并、取舍、核对 ---------------- */

  @action
  receiveShiftSheet(): void {
    if (this.incomingBatch) {
      this.notify('当前批次尚未合并完成，请先处理');
      return;
    }
    const batch = buildSampleBatch(this.shiftRevision + 1, this.show);
    this.incomingBatch = batch;
    this.mergeSession = null;
    this.persist();
    this.notify(
      `已接收换场单 R${batch.revision} · ${batch.entries.length} 条，待合并`,
    );
  }

  @action
  startMerge(): void {
    const batch = this.incomingBatch;
    if (!batch) return;
    // 同一批次已有会话则接着处理，否则建立新会话（游标 + 回执从零开始）
    if (this.mergeSession?.batchId !== batch.id) {
      this.mergeSession = {
        batchId: batch.id,
        revision: batch.revision,
        cursor: 0,
        receipts: {},
        status: 'active',
      };
    } else {
      this.mergeSession = {
        ...this.mergeSession,
        status: 'active',
        lastError: undefined,
      };
    }
    this.persist();
    this.scheduleMergeStep();
  }

  @action
  retryMerge(): void {
    if (this.mergeSession?.status !== 'failed') return;
    // 重试同一批：已回执的条目会跳过，不重复生成提示
    this.mergeSession = {
      ...this.mergeSession,
      status: 'active',
      lastError: undefined,
    };
    this.persist();
    this.scheduleMergeStep();
    this.notify('从断点重试本批，已回执条目自动跳过');
  }

  @action
  skipCurrentEntry(): void {
    const session = this.mergeSession;
    const batch = this.incomingBatch;
    if (!session || !batch || session.status !== 'failed') return;
    const entry = batch.entries[session.cursor];
    if (!entry) return;
    this.mergeSession = {
      ...session,
      cursor: session.cursor + 1,
      receipts: { ...session.receipts, [entry.id]: 'skipped' },
      status: 'active',
      lastError: undefined,
    };
    this.persist();
    this.scheduleMergeStep();
    this.notify(`已跳过条目 ${entry.id}，继续合并`);
  }

  @action
  resolveConflict(id: string, choice: 'local' | 'incoming'): void {
    const conflict = this.conflicts.find((entry) => entry.id === id);
    if (!conflict || conflict.status !== 'open') return;
    // 人工取舍即完成核对（引擎内确认并以分歧修订为依据）
    this.show = resolveConflictInShow(this.show, conflict, choice);
    this.undoStack = [];
    this.redoStack = [];
    this.conflicts = this.conflicts.map((entry) =>
      entry.id === id
        ? { ...entry, status: 'resolved', resolution: choice }
        : entry,
    );
    this.persist();
    this.notify(choice === 'incoming' ? '已采用换场单下发值' : '已保留本地值');
  }

  @action
  confirmCue(id: string): void {
    const next = confirmCueInShow(this.show, id, this.shiftRevision);
    if (next === this.show) return;
    this.show = next;
    this.undoStack = [];
    this.redoStack = [];
    this.persist();
    this.notify('已核对确认');
  }

  willDestroy(): void {
    super.willDestroy();
    window.removeEventListener('keydown', this.handleKeyboard);
    if (this.mergeTimer !== null) window.clearTimeout(this.mergeTimer);
  }

  private mutate(mutator: (show: ShowData) => void): void {
    this.undoStack.push(clone(this.show));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    const next = clone(this.show);
    mutator(next);
    next.updatedAt = new Date().toISOString();
    this.show = next;
    this.ensureSelection();
    this.persist();
  }

  /* ---------------- 换场单合并：逐条应用引擎 ---------------- */

  private scheduleMergeStep(): void {
    if (this.mergeTimer !== null) window.clearTimeout(this.mergeTimer);
    this.mergeTimer = window.setTimeout(this.processMergeStep, 260);
  }

  /**
   * 每步只处理一条并立即持久化：页面中途关掉，下次打开从游标接着走；
   * 已回执条目直接跳过，重试同一批不会重复生成提示。
   */
  private processMergeStep = (): void => {
    const session = this.mergeSession;
    const batch = this.incomingBatch;
    if (!session || !batch || session.status !== 'active') return;
    const result = stepMerge(session, batch, this.show, this.conflicts);
    this.mergeSession = result.session;
    if (result.applied) {
      this.show = result.show;
      this.conflicts = result.conflicts;
      // 合并结果已入回执，不能被本地撤销回滚：清空撤销/重做栈
      this.undoStack = [];
      this.redoStack = [];
      this.ensureSelection();
    }
    if (result.session.status === 'failed') {
      // 合并失败：进度与成功回执都已落盘，等待重试或跳过
      this.persist();
      this.notify(
        `合并中断于 ${batch.entries[session.cursor]?.id}：进度与回执已保留`,
      );
      return;
    }
    if (result.done) {
      this.shiftRevision = batch.revision;
      this.incomingBatch = null;
      this.persist();
      this.notify(
        `换场单 R${batch.revision} 合并完成 · 成功回执 ${Object.keys(result.session.receipts).length} 条`,
      );
      return;
    }
    this.persist();
    this.scheduleMergeStep();
  };

  private ensureSelection(): void {
    if (!this.show.scenes.some((scene) => scene.id === this.activeSceneId))
      this.activeSceneId = this.show.scenes[0]?.id ?? '';
    if (!this.activeScene?.cues.some((item) => item.id === this.selectedCueId))
      this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
  }

  private persist(): void {
    const state: PersistedState = {
      show: this.show,
      versions: this.versions,
      conflicts: this.conflicts,
      mergeSession: this.mergeSession,
      incomingBatch: this.incomingBatch,
      shiftRevision: this.shiftRevision,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  private notify(value: string): void {
    this.message = value;
    window.setTimeout(() => {
      if (this.message === value) this.message = '';
    }, 2200);
  }

  private handleKeyboard = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const inEditor =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.tagName === 'SELECT';
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (inEditor) return;
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveSelected(-1);
    } else if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveSelected(1);
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      this.createCueDraft();
    }
  };
}
