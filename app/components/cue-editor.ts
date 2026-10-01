import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import type {
  Cue,
  CueDraft,
  CueIssue,
  CueKind,
  Scene,
  ShowData,
  VersionDiff,
  VersionSnapshot,
  CoreField,
} from 'stage-cue-editor/models/show';
import {
  CUE_KINDS,
  OWNERS,
  CORE_FIELD_LABELS,
} from 'stage-cue-editor/models/show';
import {
  adoptFact,
  applySceneFacts,
  buildCalls,
  confirmCue,
  conflictsForCue,
  createReceipt,
  failReceipt,
  findCue,
  findFact,
  keepLocal,
  localConfirmedBasis,
  migrateLegacyShow,
  planMerge,
  resumeReceipt,
  advanceBatch,
  basisLabel,
  reopenCue,
  type CallRecord,
  type FieldConflict,
  type MergeReceipt,
  type RunSheet,
  type RunSheetState,
} from 'stage-cue-editor/models/run-sheet';
import {
  SAMPLE_RUN_SHEETS,
  findSampleSheet,
} from 'stage-cue-editor/models/sample-run-sheets';

const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const nowIso = () => new Date().toISOString();

interface StoredWorkspace {
  show: ShowData;
  versions: VersionSnapshot[];
  runSheet?: RunSheetState;
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
    updatedAt: nowIso(),
  };
}

const EMPTY_RUN_SHEET_STATE: RunSheetState = {
  latest: null,
  history: [],
  receipt: null,
  receipts: [],
};

function loadWorkspace(): {
  show: ShowData;
  versions: VersionSnapshot[];
  runSheet: RunSheetState;
} {
  let parsed: StoredWorkspace | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) parsed = JSON.parse(raw) as StoredWorkspace;
  } catch {
    parsed = null;
  }
  const show = migrateLegacyShow(parsed?.show ?? initialShow());
  return {
    show,
    versions: parsed?.versions ?? [],
    runSheet: parsed?.runSheet ?? clone(EMPTY_RUN_SHEET_STATE),
  };
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

interface ReviewItem {
  cueId: string;
  sceneId: string;
  title: string;
  sceneLabel: string;
  isNew: boolean;
  conflicts: FieldConflict[];
}

export default class CueEditorComponent extends Component {
  @tracked show: ShowData;
  @tracked versions: VersionSnapshot[];
  @tracked runSheetState: RunSheetState;
  @tracked activeSceneId: string;
  @tracked selectedCueId: string;
  @tracked draft: CueDraft | null = null;
  @tracked compareVersionId = '';
  @tracked message = '';
  @tracked search = '';
  @tracked mergeBusy = false;
  /** 演示用：让下一批在处理中途失败，验证进度保留与重试幂等。 */
  @tracked simulateFailure = false;

  private undoStack: ShowData[] = [];
  private redoStack: ShowData[] = [];
  private dragCueId = '';
  private mergeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(owner: unknown, args: Record<string, unknown>) {
    super(owner, args);
    const workspace = loadWorkspace();
    this.show = workspace.show;
    this.versions = workspace.versions;
    this.runSheetState = workspace.runSheet;
    this.activeSceneId = this.show.scenes[0]?.id ?? '';
    this.selectedCueId = this.show.scenes[0]?.cues[0]?.id ?? '';
    window.addEventListener('keydown', this.handleKeyboard);
    // 页面中途关掉再打开：若上次批次仍在进行，从断点继续处理。
    if (
      this.runSheetState.receipt?.status === 'running' &&
      this.runSheetState.latest
    ) {
      setTimeout(() => this.runMergeLoop(), 300);
    }
  }

  get coreFieldLabels(): Record<CoreField, string> {
    return CORE_FIELD_LABELS;
  }

  get sampleSheets(): RunSheet[] {
    return SAMPLE_RUN_SHEETS;
  }

  get currentSheet(): RunSheet | null {
    return this.runSheetState.latest;
  }

  get currentReceipt(): MergeReceipt | null {
    return this.runSheetState.receipt;
  }

  /** 后台换场单事实推导出的上下场与人员到场（只读事实）。 */
  get calls(): Array<
    CallRecord & { sceneLabel: string; cueTitle: string; orphan: boolean }
  > {
    const sheet = this.currentSheet;
    if (!sheet) return [];
    return buildCalls(sheet).map((call) => {
      const scene = this.show.scenes.find((item) => item.id === call.sceneId);
      const located = findCue(this.show, call.cueId);
      return {
        ...call,
        sceneLabel: scene ? `${scene.act} ${scene.name}` : call.sceneId,
        cueTitle: located?.cue.title ?? '（本地已删除）',
        orphan: !located,
      };
    });
  }

  get receiptHistory(): MergeReceipt[] {
    return this.runSheetState.receipts;
  }

  get mergeProgress(): number {
    const receipt = this.currentReceipt;
    if (!receipt || receipt.totalCues === 0) return 0;
    return Math.round(
      (receipt.processedCueIds.length / receipt.totalCues) * 100,
    );
  }

  get activeScene(): Scene | undefined {
    return this.show.scenes.find((scene) => scene.id === this.activeSceneId);
  }

  get selectedCue(): Cue | undefined {
    return this.activeScene?.cues.find(
      (item) => item.id === this.selectedCueId,
    );
  }

  get selectedCueConflicts(): FieldConflict[] {
    return this.selectedCue
      ? conflictsForCue(this.selectedCue, this.currentSheet)
      : [];
  }

  get selectedCueFact() {
    const cue = this.selectedCue;
    const sheet = this.currentSheet;
    if (!cue || !sheet) return null;
    return findFact(sheet, cue.id) ?? null;
  }

  get selectedCueStale(): boolean {
    const cue = this.selectedCue;
    const receipt = this.currentReceipt;
    return Boolean(
      cue && receipt?.staleConfirmedCueIds.includes(cue.id) && cue.confirmed,
    );
  }

  get cueRows() {
    if (!this.activeScene) return [];
    const sheet = this.currentSheet;
    const receipt = this.currentReceipt;
    return this.activeScene.cues.map((item, index) => {
      const conflicts = conflictsForCue(item, sheet);
      return {
        ...item,
        index,
        start: timeLabel(this.activeScene as Scene, item.offset),
        end: timeLabel(this.activeScene as Scene, item.offset + item.duration),
        selected: item.id === this.selectedCueId,
        hasIssue: this.issues.some((issue) => issue.cueId === item.id),
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
        statusLabel: item.confirmed ? '已确认' : '待核对',
        statusClass: item.confirmed ? 'is-confirmed' : 'is-pending',
        originLabel: item.origin === 'runsheet' ? '换场单' : '本地',
        originClass:
          item.origin === 'runsheet' ? 'origin-runsheet' : 'origin-local',
        conflictCount: conflicts.length,
        inReview: Boolean(
          !item.confirmed &&
          (receipt?.affectedCueIds.includes(item.id) || conflicts.length),
        ),
        stale: Boolean(
          item.confirmed && receipt?.staleConfirmedCueIds.includes(item.id),
        ),
        basisVersion: basisLabel(this.earliestBasis(item)),
      };
    });
  }

  private earliestBasis(item: Cue): string | undefined {
    const versions = Object.values(item.factBasis ?? {}).filter(Boolean);
    return versions[0];
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

  /** 重新核对队列：受本批影响且未确认的提示 + 仍有未解决字段分歧的提示。 */
  get reviewQueue(): ReviewItem[] {
    const sheet = this.currentSheet;
    const receipt = this.currentReceipt;
    if (!sheet) return [];
    return this.allCues.flatMap(({ cue, scene }) => {
      if (cue.confirmed || !findFact(sheet, cue.id)) return [];
      const conflicts = conflictsForCue(cue, sheet);
      const touched =
        receipt?.affectedCueIds.includes(cue.id) ||
        receipt?.newCueIds.includes(cue.id);
      if (!touched && conflicts.length === 0) return [];
      return [
        {
          cueId: cue.id,
          sceneId: scene.id,
          title: cue.title,
          sceneLabel: `${scene.act} ${scene.name}`,
          isNew: Boolean(receipt?.newCueIds.includes(cue.id)),
          conflicts,
        },
      ];
    });
  }

  /** 已确认但换场单出现新事实：保留旧依据，仅列出供主动复审。 */
  get staleConfirmedItems(): ReviewItem[] {
    const sheet = this.currentSheet;
    const receipt = this.currentReceipt;
    if (!sheet || !receipt) return [];
    return receipt.staleConfirmedCueIds.flatMap((cueId) => {
      const located = findCue(this.show, cueId);
      if (!located || !located.cue.confirmed) return [];
      return [
        {
          cueId,
          sceneId: located.scene.id,
          title: located.cue.title,
          sceneLabel: `${located.scene.act} ${located.scene.name}`,
          isNew: false,
          conflicts: conflictsForCue(located.cue, sheet),
        },
      ];
    });
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
      const conflicts = conflictsForCue(item, this.currentSheet);
      if (conflicts.length) {
        issues.push({
          id: `conflict-${item.id}`,
          severity: item.confirmed ? 'info' : 'warning',
          title: item.confirmed
            ? '换场单有新版事实（保留旧依据）'
            : '换场单分歧待核对',
          detail: `「${item.title}」${conflicts.map((entry) => CORE_FIELD_LABELS[entry.field]).join('、')}与换场单 ${this.currentSheet?.version} 不一致。`,
          sceneId: scene.id,
          cueId: item.id,
        });
      }
      if (
        !item.confirmed &&
        item.origin === 'runsheet' &&
        this.currentReceipt?.affectedCueIds.includes(item.id)
      ) {
        issues.push({
          id: `review-${item.id}`,
          severity: 'info',
          title: '换场单更新待核对',
          detail: `「${item.title}」受新版换场单影响，请重新核对。`,
          sceneId: scene.id,
          cueId: item.id,
        });
      }
    });

    // 换场单事实侧检查：上下场记录找不到本地提示、人员到场未落实
    this.calls.forEach((call) => {
      if (call.orphan) {
        issues.push({
          id: `orphan-call-${call.id}`,
          severity: 'warning',
          title: '上下场记录缺少对应提示',
          detail: `${call.sceneLabel} 的上下场安排引用了本地已删除的提示 ${call.cueId}。`,
          sceneId: call.sceneId,
        });
      }
      const unattended = call.personnel.filter(
        (name) => name.includes('待到场') || name.includes('待指定'),
      );
      if (unattended.length) {
        issues.push({
          id: `personnel-${call.id}`,
          severity: 'warning',
          title: '人员到场未落实',
          detail: `${call.sceneLabel}「${call.cueTitle}」：${unattended.join('、')}。`,
          sceneId: call.sceneId,
          cueId: call.cueId,
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

  @action
  selectScene(id: string): void {
    this.activeSceneId = id;
    this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
    this.draft = null;
  }

  @action
  selectCue(id: string): void {
    if (!id) return;
    const scene = this.show.scenes.find((item) =>
      item.cues.some((cue) => cue.id === id),
    );
    if (scene) this.activeSceneId = scene.id;
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
    const existing = this.activeScene.cues.find((item) => item.id === draft.id);
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene) return;
      const sheet = this.runSheetState.latest;
      // 本地手工改动核心字段，视为对当前换场单版本作出「保留本地」的编排决定。
      const resolvedAgainst = {
        ...(existing?.resolvedAgainst ?? {}),
      } as Partial<Record<CoreField, string>>;
      if (existing && sheet && findFact(sheet, existing.id)) {
        (
          [
            'kind',
            'title',
            'duration',
            'owner',
            'lighting',
            'sound',
          ] as CoreField[]
        ).forEach((field) => {
          if (
            String(draft[field] ?? '').trim() !==
            String(existing[field] ?? '').trim()
          ) {
            resolvedAgainst[field] = sheet.version;
          }
        });
        (['props', 'cast'] as const).forEach((field) => {
          const incoming = String(draft[field])
            .split(/[、,，]/)
            .map((value) => value.trim())
            .filter(Boolean)
            .sort()
            .join('|');
          const current = [...(existing[field] as string[])].sort().join('|');
          if (incoming !== current) resolvedAgainst[field] = sheet.version;
        });
      }
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
        offset: existing?.offset ?? 0,
        // 本地编排层新建的提示与旧数据一样，按本地确认处理。
        origin: existing?.origin ?? 'local',
        confirmed: existing?.confirmed ?? true,
        confirmedAt: existing?.confirmedAt,
        factBasis: existing?.factBasis ?? localConfirmedBasis(),
        resolvedAgainst,
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
      source: 'local',
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
    copied.source = 'local';
    copied.cues = copied.cues.map((item) => ({
      ...item,
      id: uid('cue'),
      dependsOn: [],
      origin: 'local',
      confirmed: true,
      factBasis: localConfirmedBasis(),
      resolvedAgainst: {},
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
          .filter(Boolean) as never;
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

  /* ------------------------------ 换场单合并 ------------------------------ */

  @action
  toggleSimulateFailure(event: Event): void {
    this.simulateFailure = (event.target as HTMLInputElement).checked;
  }

  @action
  importSampleSheet(version: string): void {
    const sheet = findSampleSheet(version);
    if (sheet) this.startBatch(sheet);
  }

  @action
  startBatch(sheet: RunSheet): void {
    if (this.mergeBusy) {
      this.notify('上一批仍在处理中');
      return;
    }
    const receipt = this.runSheetState.receipt;
    if (receipt?.status === 'running') {
      this.notify('上一批尚未完成，将从断点继续');
      return;
    }
    if (
      this.runSheetState.latest?.version === sheet.version &&
      receipt?.status === 'completed'
    ) {
      this.notify(`换场单 ${sheet.version} 已合并，无需重复接收`);
      return;
    }
    const previous = this.runSheetState.latest;
    // 先应用场次结构事实（顺序/结构），再按提示逐条处理，保证中途失败也可续跑。
    const withScenes = applySceneFacts(this.show, sheet);
    const plan = planMerge(previous, sheet, withScenes);
    const created = createReceipt(sheet, plan, nowIso());
    created.sceneApplied = true;
    created.callsApplied = true;
    this.commitBatch(withScenes, sheet, created);
    // 批次过程不进入撤销栈，避免几十次逐条落盘污染文档级撤销。
    this.undoStack = [];
    this.redoStack = [];
    this.ensureSelection();
    this.notify(
      `开始接收换场单 ${sheet.version}：${plan.newCueIds.length} 条新增，${plan.affected.length} 条待核对`,
    );
    this.runMergeLoop();
  }

  @action
  retryBatch(): void {
    const receipt = this.currentReceipt;
    const sheet = this.currentSheet;
    if (!receipt || !sheet || receipt.status !== 'failed' || this.mergeBusy)
      return;
    this.commitBatch(this.show, sheet, resumeReceipt(receipt));
    this.notify(
      `重试批次 ${receipt.version}：已完成的 ${receipt.processedCueIds.length} 条不重复处理`,
    );
    this.runMergeLoop();
  }

  private runMergeLoop(): void {
    if (!this.currentSheet || this.currentReceipt?.status !== 'running') return;
    this.mergeBusy = true;
    const step = (): void => {
      const sheet = this.currentSheet;
      const receipt = this.currentReceipt;
      if (!sheet || !receipt) {
        this.mergeBusy = false;
        return;
      }
      if (receipt.status !== 'running') {
        this.mergeBusy = false;
        return;
      }
      // 演示故障注入：成功处理 2 条后中断，验证进度与成功回执保留。
      if (this.simulateFailure && receipt.processedCueIds.length >= 2) {
        this.simulateFailure = false;
        const failed = failReceipt(
          receipt,
          `模拟故障：处理到第 ${receipt.processedCueIds.length + 1} 条时中断（已保留进度）`,
        );
        this.commitBatch(this.show, sheet, failed);
        this.mergeBusy = false;
        this.notify('批次中断：进度与成功回执已保留，可重试本批');
        return;
      }
      const result = advanceBatch(this.show, sheet, receipt, nowIso(), 1);
      this.commitBatch(result.show, sheet, result.receipt);
      this.ensureSelection();
      if (result.receipt.status === 'completed') {
        this.mergeBusy = false;
        this.notify(
          `换场单 ${sheet.version} 接收完成：仅受影响的未确认提示需重新核对，已确认内容保留旧依据`,
        );
        return;
      }
      this.mergeTimer = setTimeout(step, 220);
    };
    this.mergeTimer = setTimeout(step, 80);
  }

  private commitBatch(
    show: ShowData,
    sheet: RunSheet,
    receipt: MergeReceipt,
  ): void {
    this.show = show;
    const history = this.runSheetState.history.filter(
      (item) => item.version !== sheet.version,
    );
    history.push(sheet);
    const receipts = this.runSheetState.receipts.filter(
      (item) => item.batchId !== receipt.batchId,
    );
    receipts.push(receipt);
    this.runSheetState = {
      latest: sheet,
      history: history.slice(-10),
      receipt,
      receipts: receipts.slice(-10),
    };
    this.persist();
  }

  /* ------------------------------ 核对期决定 ------------------------------ */

  @action
  resolveKeepLocal(cueId: string, field: CoreField): void {
    const sheet = this.currentSheet;
    if (!sheet) return;
    this.applyCueDecision(keepLocal(this.show, cueId, field, sheet, nowIso()));
  }

  @action
  resolveAdoptFact(cueId: string, field: CoreField): void {
    const sheet = this.currentSheet;
    if (!sheet) return;
    this.applyCueDecision(adoptFact(this.show, cueId, field, sheet, nowIso()));
  }

  @action
  confirmSelectedCue(): void {
    const cue = this.selectedCue;
    if (!cue) return;
    this.applyCueDecision(
      confirmCue(this.show, cue.id, this.currentSheet, nowIso()),
    );
    this.notify('提示已确认，后续换场单更新不再自动覆盖该依据');
  }

  @action
  reopenSelectedCue(): void {
    const cue = this.selectedCue;
    if (!cue) return;
    this.applyCueDecision(reopenCue(this.show, cue.id, nowIso()));
    this.notify('提示已重新打开核对');
  }

  private applyCueDecision(next: ShowData): void {
    if (next === this.show) return;
    this.undoStack.push(clone(this.show));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    this.show = next;
    this.ensureSelection();
    this.persist();
  }

  /* -------------------------------- 其余 -------------------------------- */

  @action
  lockVersion(): void {
    const snapshot: VersionSnapshot = {
      id: uid('version'),
      name: `锁定版 ${this.versions.length + 1}`,
      createdAt: nowIso(),
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

  willDestroy(): void {
    super.willDestroy();
    window.removeEventListener('keydown', this.handleKeyboard);
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
  }

  private mutate(mutator: (show: ShowData) => void): void {
    this.undoStack.push(clone(this.show));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    const next = clone(this.show);
    mutator(next);
    next.updatedAt = nowIso();
    this.show = next;
    this.ensureSelection();
    this.persist();
  }

  private ensureSelection(): void {
    if (!this.show.scenes.some((scene) => scene.id === this.activeSceneId))
      this.activeSceneId = this.show.scenes[0]?.id ?? '';
    if (!this.activeScene?.cues.some((item) => item.id === this.selectedCueId))
      this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
  }

  private persist(): void {
    const workspace: StoredWorkspace = {
      show: this.show,
      versions: this.versions,
      runSheet: this.runSheetState,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  }

  private notify(value: string): void {
    this.message = value;
    window.setTimeout(() => {
      if (this.message === value) this.message = '';
    }, 2600);
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
