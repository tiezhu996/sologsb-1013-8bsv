import { module, test } from 'qunit';
import type { Cue, Scene, ShowData } from 'stage-cue-editor/models/show';
import { CORE_FIELDS } from 'stage-cue-editor/models/show';
import { SAMPLE_RUN_SHEETS } from 'stage-cue-editor/models/sample-run-sheets';
import {
  adoptFact,
  advanceBatch,
  applySceneFacts,
  confirmCue,
  conflictsForCue,
  createReceipt,
  findCue,
  keepLocal,
  localConfirmedBasis,
  migrateLegacyShow,
  planMerge,
  processCueFact,
  resumeReceipt,
  FACT_BASIS_LOCAL,
} from 'stage-cue-editor/models/run-sheet';

const NOW = '2026-10-01T19:00:00.000Z';

function makeCue(id: string, overrides: Partial<Cue> = {}): Cue {
  return {
    id,
    kind: '灯光',
    title: id,
    duration: 30,
    owner: '李岚',
    lighting: '',
    sound: '',
    props: [],
    cast: [],
    notes: '',
    dependsOn: [],
    offset: 0,
    origin: 'local',
    confirmed: true,
    factBasis: localConfirmedBasis(),
    resolvedAgainst: {},
    ...overrides,
  };
}

function makeShow(
  cues: Cue[],
  scenes: Array<Pick<Scene, 'id'> & Partial<Scene>> = [],
): ShowData {
  const usedScenes = scenes.length ? scenes : [{ id: 'scene-1', cues }];
  return {
    title: '测试演出',
    venue: '测试场',
    date: '2026-10-01',
    updatedAt: NOW,
    scenes: usedScenes.map((scene, index) => ({
      act: '第一幕',
      name: `S${index + 1}`,
      title: `场次 ${index + 1}`,
      startTime: '19:30',
      locked: false,
      cues: [],
      source: 'local',
      ...scene,
    })) as Scene[],
  };
}

const V1 = SAMPLE_RUN_SHEETS[0]!;
const V2 = SAMPLE_RUN_SHEETS[1]!;

module('Unit | merge engine | 旧数据迁移', function () {
  test('没有来源标记的旧数据按本地确认处理', function (assert) {
    const legacy = makeShow([
      makeCue('cue-a', { origin: undefined, confirmed: undefined }),
    ]);
    const migrated = migrateLegacyShow(legacy);
    const cue = migrated.scenes[0]!.cues[0]!;
    assert.strictEqual(cue.origin, 'local', '来源标记补为 local');
    assert.true(cue.confirmed, '默认已确认');
    assert.strictEqual(
      migrated.scenes[0]!.source,
      'local',
      '场次来源补为 local',
    );
    CORE_FIELDS.forEach((field) => {
      assert.strictEqual(
        cue.factBasis?.[field],
        FACT_BASIS_LOCAL,
        `${field} 依据为本地确认`,
      );
    });
  });
});

module('Unit | merge engine | 计划与所有权', function () {
  test('新事实提示进入受影响集合，已确认提示变化进入旧依据保留集合', function (assert) {
    // 本地只有 cue-light-1，与 V1 事实完全一致，且已确认
    const cue = makeCue('cue-light-1', {
      title: '观众席渐暗 · 面光起',
      duration: 45,
      lighting: 'FOH 1 号面光 65%，侧光暖白 40%',
    });
    const show = makeShow([cue], [{ id: 'scene-1', cues: [cue] }]);

    const plan = planMerge(null, V1, show);
    assert.ok(
      plan.newCueIds.includes('cue-caption-1'),
      '本地没有的字幕提示计为新增',
    );
    assert.ok(plan.affected.includes('cue-caption-1'), '新增提示需要核对');
    assert.notOk(
      plan.affected.includes('cue-light-1'),
      '事实与本地一致的已确认提示不受影响',
    );
    assert.notOk(
      plan.staleConfirmed.includes('cue-light-1'),
      '无变化不列入旧依据保留',
    );

    // V2 改了面光亮度：cue-light-1 已确认 → 只进 staleConfirmed，不进 affected
    const planV2 = planMerge(V1, V2, show);
    assert.ok(
      planV2.staleConfirmed.includes('cue-light-1'),
      '已确认且事实变化：保留旧依据',
    );
    assert.notOk(
      planV2.affected.includes('cue-light-1'),
      '已确认提示不强制重新核对',
    );
    assert.ok(planV2.newCueIds.includes('cue-actor-wait-2'), 'V2 新增候场提示');
    assert.notOk(
      planV2.changedExisting.includes('cue-sound-1'),
      '未变化提示不列入变更',
    );
  });

  test('未确认提示事实变化时进入重新核对集合', function (assert) {
    const cue = makeCue('cue-light-1', {
      origin: 'runsheet',
      confirmed: false,
      lighting: '旧亮度',
      factBasis: CORE_FIELDS.reduce(
        (basis, field) => ({ ...basis, [field]: 'GS-V1' }),
        {} as Partial<Record<(typeof CORE_FIELDS)[number], string>>,
      ),
    });
    const show = makeShow([cue]);
    const planV2 = planMerge(V1, V2, show);
    assert.ok(
      planV2.affected.includes('cue-light-1'),
      '未确认提示受影响需重新核对',
    );
    assert.notOk(
      planV2.staleConfirmed.includes('cue-light-1'),
      '不进旧依据集合',
    );
  });
});

module('Unit | merge engine | 批次处理与幂等', function () {
  test('逐条处理、中途失败保留进度，重试同批不重复生成提示', function (assert) {
    let show = makeShow([]);
    show = applySceneFacts(show, V1);
    const receipt = createReceipt(V1, planMerge(null, V1, show), NOW);

    // 每次只处理 1 条，模拟处理到第 3 条前页面关闭 / 中断
    let state = advanceBatch(show, V1, receipt, NOW, 1);
    assert.strictEqual(state.receipt.processedCueIds.length, 1);
    assert.strictEqual(state.receipt.status, 'running');
    state = advanceBatch(state.show, V1, state.receipt, NOW, 1);
    assert.strictEqual(state.receipt.processedCueIds.length, 2);
    const cueCountAfterTwo = state.show.scenes.flatMap(
      (scene) => scene.cues,
    ).length;
    assert.strictEqual(cueCountAfterTwo, 2, '只生成了已处理的 2 条提示');

    // 用持久化后的回执重试（模拟刷新页面）：从断点继续，前 2 条不重复处理
    const resumed = resumeReceipt({
      ...state.receipt,
      status: 'failed',
      error: '中断',
    });
    state = advanceBatch(
      state.show,
      V1,
      resumed,
      NOW,
      Number.POSITIVE_INFINITY,
    );
    assert.strictEqual(state.receipt.status, 'completed');
    assert.strictEqual(state.receipt.processedCueIds.length, V1.cues.length);
    const allCueIds = state.show.scenes
      .flatMap((scene) => scene.cues)
      .map((cue) => cue.id);
    assert.strictEqual(allCueIds.length, new Set(allCueIds).size, '无重复提示');
    assert.strictEqual(allCueIds.length, V1.cues.length, '全部提示各生成一次');

    // 再次重试同一批：幂等，不新增
    const again = advanceBatch(state.show, V1, state.receipt, NOW);
    assert.strictEqual(
      again.show.scenes.flatMap((scene) => scene.cues).length,
      V1.cues.length,
    );
    assert.deepEqual(
      again.receipt.processedCueIds,
      state.receipt.processedCueIds,
    );
  });

  test('换场单事实绝不自动覆盖已有本地值', function (assert) {
    const cue = makeCue('cue-light-1', {
      lighting: '舞台监督手工编排的亮度',
      origin: 'runsheet',
      confirmed: false,
    });
    const show = makeShow([cue]);
    const result = processCueFact(show, V2, 'cue-light-1', NOW);
    const local = findCue(result, 'cue-light-1')!.cue;
    assert.strictEqual(
      local.lighting,
      '舞台监督手工编排的亮度',
      '本地灯光值保留，不被事实覆盖',
    );
    const conflicts = conflictsForCue(local, V2);
    assert.ok(
      conflicts.some((item) => item.field === 'lighting'),
      '字段分歧并列暴露',
    );
  });
});

module('Unit | merge engine | 字段分歧与人工决定', function () {
  test('保留本地与采用事实都是字段级显式决定', function (assert) {
    const cue = makeCue('cue-light-1', {
      lighting: '本地亮度',
      origin: 'runsheet',
      confirmed: false,
    });
    let show = makeShow([cue]);

    // 采用事实
    show = adoptFact(show, 'cue-light-1', 'lighting', V2, NOW);
    let local = findCue(show, 'cue-light-1')!.cue;
    assert.strictEqual(
      local.lighting,
      V2.cues[0]!.lighting,
      '采用事实后本地值更新为事实值',
    );
    assert.strictEqual(local.resolvedAgainst?.lighting, 'GS-V2');
    assert.notOk(
      conflictsForCue(local, V2).some((item) => item.field === 'lighting'),
      '已决定字段不再出现在分歧里',
    );

    // 保留本地
    const cue2 = makeCue('cue-actor-1', {
      kind: '演员',
      title: '说书人自左台入场',
      duration: 90,
      owner: '赵一帆',
      cast: ['说书人／周启'],
      props: ['折扇'],
      origin: 'runsheet',
      confirmed: false,
    });
    show = makeShow([local, cue2]);
    show = keepLocal(show, 'cue-actor-1', 'title', V2, NOW);
    local = findCue(show, 'cue-actor-1')!.cue;
    assert.strictEqual(
      local.title,
      '说书人自左台入场',
      '保留本地：标题不被改写',
    );
    const remaining = conflictsForCue(local, V2).map((item) => item.field);
    assert.notOk(remaining.includes('title'), '标题分歧已按保留本地处理');
  });

  test('确认后换场单再更新，旧依据保留且本地值不变', function (assert) {
    const cue = makeCue('cue-light-1', {
      lighting: V1.cues[0]!.lighting,
      origin: 'runsheet',
      confirmed: false,
      factBasis: CORE_FIELDS.reduce(
        (basis, field) => ({ ...basis, [field]: 'GS-V1' }),
        {} as Partial<Record<(typeof CORE_FIELDS)[number], string>>,
      ),
    });
    let show = makeShow([cue]);
    show = confirmCue(show, 'cue-light-1', V1, NOW);

    // 再下发 V2：处理该提示不应改动任何本地值与依据
    const after = processCueFact(show, V2, 'cue-light-1', NOW);
    const local = findCue(after, 'cue-light-1')!.cue;
    assert.strictEqual(
      local.lighting,
      V1.cues[0]!.lighting,
      '已确认灯光值保留旧依据',
    );
    assert.strictEqual(local.factBasis?.lighting, 'GS-V1', '依据仍是 GS-V1');
    assert.true(local.confirmed, '确认状态不被新版本推翻');

    const planV2 = planMerge(V1, V2, after);
    assert.ok(
      planV2.staleConfirmed.includes('cue-light-1'),
      '列入旧依据保留提示，而非强制重核',
    );
    assert.ok(conflictsForCue(local, V2).length > 0, '差异仍可见，供主动复审');
  });
});

module('Unit | merge engine | 场次事实', function () {
  test('按换场单顺序排列场次，本地独有场次保留在末尾', function (assert) {
    const show = makeShow(
      [],
      [
        { id: 'scene-local', cues: [], title: '本地加排' },
        { id: 'scene-2', cues: [] },
        { id: 'scene-1', cues: [] },
      ],
    );
    const result = applySceneFacts(show, V1);
    assert.deepEqual(
      result.scenes.map((scene) => scene.id),
      ['scene-1', 'scene-2', 'scene-local'],
    );
    const scene2 = result.scenes.find((scene) => scene.id === 'scene-2')!;
    assert.strictEqual(scene2.title, '宫门夜宴', '场次结构事实被同步');
    assert.strictEqual(scene2.source, 'runsheet');
    assert.strictEqual(
      result.scenes[2]!.title,
      '本地加排',
      '本地编排场次不被删除',
    );
  });

  test('重复应用同一版场次事实保持幂等', function (assert) {
    const show = applySceneFacts(makeShow([]), V1);
    const again = applySceneFacts(show, V1);
    assert.deepEqual(
      again.scenes.map((scene) => scene.id),
      ['scene-1', 'scene-2'],
    );
  });
});

module('Unit | merge engine | 完整两版流程', function () {
  test('V1 合并 → 核对确认 → V2 只影响未确认项', function (assert) {
    // 旧数据：与 V1 提示 id 相同，会被迁移为本地已确认
    const localCues = V1.cues.map((fact) =>
      makeCue(fact.cueId, {
        kind: fact.kind,
        title: fact.title,
        duration: fact.duration,
        owner: fact.owner,
        lighting: fact.lighting,
        sound: fact.sound,
        props: [...fact.props],
        cast: [...fact.cast],
      }),
    );
    let show = migrateLegacyShow(
      makeShow(localCues, [
        { id: 'scene-1', cues: localCues.slice(0, 5) },
        { id: 'scene-2', cues: localCues.slice(5) },
      ]),
    );

    // 接收 V1：全部一致，无受影响未确认提示
    let plan = planMerge(null, V1, show);
    assert.strictEqual(
      plan.affected.length,
      0,
      '旧数据按本地确认：与事实一致时无需核对',
    );

    // 把字幕提示手动改为未确认（舞台监督要重看），再接收 V2
    const caption = findCue(show, 'cue-caption-1')!.cue;
    caption.confirmed = false;
    caption.factBasis!.owner = 'GS-V1';
    show = { ...show, updatedAt: NOW };

    plan = planMerge(V1, V2, show);
    assert.ok(
      plan.affected.includes('cue-caption-1'),
      '未确认的字幕提示需重新核对负责人',
    );
    assert.ok(
      plan.staleConfirmed.includes('cue-light-1'),
      '已确认的面光提示保留旧依据',
    );
    assert.ok(
      plan.newCueIds.includes('cue-actor-wait-2'),
      '新增候场提示进队列',
    );

    // 完成 V2 批次
    let receipt = createReceipt(V2, plan, NOW);
    const merged = advanceBatch(show, V2, receipt, NOW);
    receipt = merged.receipt;
    show = merged.show;
    assert.strictEqual(receipt.status, 'completed');
    assert.ok(findCue(show, 'cue-actor-wait-2'), '新提示已生成且未确认');
    assert.false(
      findCue(show, 'cue-actor-wait-2')!.cue.confirmed,
      '新事实提示待核对',
    );

    // 面光已确认，值与依据保持 V1
    const light = findCue(show, 'cue-light-1')!.cue;
    assert.strictEqual(light.lighting, V1.cues[0]!.lighting);
    assert.strictEqual(
      light.factBasis?.lighting,
      FACT_BASIS_LOCAL,
      '旧数据本地确认依据不被 V2 改写',
    );
  });
});
