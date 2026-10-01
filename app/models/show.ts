export type CueKind = '灯光' | '音响' | '道具' | '演员' | '舞台' | '字幕';

/**
 * 来源标记：local = 本地提示表编排，shift-sheet = 后台换场单下发。
 * 旧数据没有来源标记时，迁移一律按 local + 已确认处理。
 */
export type CueSource = 'local' | 'shift-sheet';

/**
 * 提示的确认状态与依据。
 * - confirmed：已确认，basisRevision 记录确认时所依据的换场单修订（null = 本地旧数据）。
 * - pending：待核对，basisRevision 记录需要对照核对的换场单修订。
 */
export interface CueConfirmation {
  status: 'confirmed' | 'pending';
  source: CueSource;
  basisRevision: number | null;
}

export interface Cue {
  id: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string[];
  cast: string[];
  notes: string;
  dependsOn: string[];
  offset: number;
  /** 上下场事实（换场单可下发的核心字段之一） */
  entrance: string;
  confirmation: CueConfirmation;
}

export interface Scene {
  id: string;
  act: string;
  name: string;
  title: string;
  startTime: string;
  locked: boolean;
  cues: Cue[];
}

export interface ShowData {
  title: string;
  venue: string;
  date: string;
  scenes: Scene[];
  updatedAt: string;
}

export interface VersionSnapshot {
  id: string;
  name: string;
  createdAt: string;
  data: ShowData;
}

export interface CueDraft {
  id?: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string;
  cast: string;
  notes: string;
  dependsOn: string;
  entrance: string;
}

export interface CueIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  icon?: string;
  sceneId?: string;
  cueId?: string;
}

export interface VersionDiff {
  id: string;
  changed: boolean;
  label: string;
  before: string;
  after: string;
}

export const CUE_KINDS: CueKind[] = [
  '灯光',
  '音响',
  '道具',
  '演员',
  '舞台',
  '字幕',
];
export const OWNERS = ['李岚', '周启', '陈默', '赵一帆', '孙禾', '待指定'];

/* ------------------------------------------------------------------ */
/* 换场单合并：状态所有权                                                */
/*                                                                    */
/* 换场单（后台）只提供事实：场次顺序、上下场、人员到场。               */
/* 本地提示表负责编排：灯光、音响、道具、时长、负责人、备注、提示顺序。 */
/* 合并只写事实字段；同一提示的核心字段（上下场 / 人员）出现分歧时      */
/* 并列保留为 CueConflict，绝不自动覆盖本地值。                         */
/* ------------------------------------------------------------------ */

export type ShiftEntryType = 'scene-order' | 'entrance' | 'arrival';

export interface ShiftSheetEntry {
  /** 稳定条目键：同一批次重试时凭它幂等，不重复生成提示 */
  id: string;
  type: ShiftEntryType;
  sceneId: string;
  cueId?: string;
  /** scene-order：后台下发的场次顺序（scene id 列表） */
  order?: string[];
  /** entrance：上下场事实 */
  entrance?: string;
  /** arrival：人员到场事实 */
  arrival?: string[];
  /** 目标提示不存在时按此创建（确定性 id = cue-{entry.id}） */
  create?: { kind: CueKind; title: string };
}

export interface ShiftSheetBatch {
  id: string;
  revision: number;
  entries: ShiftSheetEntry[];
}

/** 核心字段分歧：本地值与下发值并列保留，人工取舍前不覆盖 */
export interface CueConflict {
  id: string;
  sceneId: string;
  cueId: string;
  field: 'entrance' | 'cast';
  localValue: string;
  incomingValue: string;
  revision: number;
  status: 'open' | 'resolved';
  resolution?: 'local' | 'incoming';
}

/**
 * 合并会话：批次游标 + 成功回执。
 * 每应用一条即持久化，页面关掉再打开可从上次批次接着处理；
 * 合并失败后保留进度与回执，重试同一批跳过已回执条目。
 */
export interface MergeSession {
  batchId: string;
  revision: number;
  cursor: number;
  receipts: Record<string, 'applied' | 'skipped'>;
  status: 'active' | 'failed' | 'done';
  lastError?: string;
}

export interface PersistedState {
  show: ShowData;
  versions: VersionSnapshot[];
  conflicts?: CueConflict[];
  mergeSession?: MergeSession | null;
  incomingBatch?: ShiftSheetBatch | null;
  shiftRevision?: number;
}
