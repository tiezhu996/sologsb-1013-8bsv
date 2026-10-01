export type CueKind = '灯光' | '音响' | '道具' | '演员' | '舞台' | '字幕';

/**
 * 换场单与本地提示表都会提供、需要核对归属的核心字段。
 * offset（时间轴）、notes（工作备注）、dependsOn（前置依赖）仅归本地编排层所有。
 */
export type CoreField =
  | 'kind'
  | 'title'
  | 'duration'
  | 'owner'
  | 'lighting'
  | 'sound'
  | 'props'
  | 'cast';

export const CORE_FIELDS: CoreField[] = [
  'kind',
  'title',
  'duration',
  'owner',
  'lighting',
  'sound',
  'props',
  'cast',
];

export const CORE_FIELD_LABELS: Record<CoreField, string> = {
  kind: '类型',
  title: '标题',
  duration: '时长',
  owner: '负责人',
  lighting: '灯光',
  sound: '音响',
  props: '道具',
  cast: '演员',
};

/** 提示来源：本地编排新建，或由后台换场单事实生成。 */
export type CueOrigin = 'local' | 'runsheet';

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
  /** 来源标记；旧数据缺省时迁移为 'local'（按本地确认处理）。 */
  origin?: CueOrigin;
  /** 本地是否已完成核对确认。 */
  confirmed?: boolean;
  confirmedAt?: string;
  /** 各核心字段当前本地值所对齐的换场单版本（采用事实或恰好一致时记录）。 */
  factBasis?: Partial<Record<CoreField, string>>;
  /** 各核心字段已做出「保留本地 / 采用事实」决定时所针对的换场单版本。 */
  resolvedAgainst?: Partial<Record<CoreField, string>>;
}

export interface Scene {
  id: string;
  act: string;
  name: string;
  title: string;
  startTime: string;
  locked: boolean;
  cues: Cue[];
  source?: CueOrigin;
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
