import assert from 'node:assert';
import { parseTimecode, formatTimecode } from '../src/lib/time';
import { parseVTT, serializeVTT } from '../src/lib/vtt';
import { applyDrag } from '../src/lib/solver';
import { planTwoPointSync } from '../src/lib/sync';
import { planMerge, joinBilingualText } from '../src/lib/merge';
import { planExcerpt, rewriteTimestampTags } from '../src/lib/excerpt';
import { suggestWrap, planSmartWrap, visibleWidth } from '../src/lib/wrap';
import { applyTerminology, planTerminology } from '../src/lib/term';
import { parseSpeakerTable, planSpeakers, applyVoiceTag, voiceInfo } from '../src/lib/speaker';
import { detectIssues } from '../src/lib/issues';
import {
  parseCueSettings,
  serializeCueSettings,
  getCueSetting,
  updateCueSetting,
  validateLayoutValue,
  analyzeCueLayout,
} from '../src/lib/layout';
import type { Cue, Settings } from '../src/lib/types';

let passed = 0;
function ok(name: string) { passed++; console.log('  ✓', name); }

interface TCue { id: string; s: number; e: number; l?: boolean }
function mk(spec: TCue[]): Cue[] {
  return spec.map((c) => ({
    id: c.id, identifier: '', start: c.s, end: c.e, text: `t-${c.id}`, settings: '', locked: !!c.l,
  }));
}
const get = (cs: Cue[], id: string) => cs.find((c) => c.id === id)!;

// ---------- 时间码 ----------
assert.strictEqual(parseTimecode('00:03.200'), 3.2);
assert.strictEqual(parseTimecode('01:02:03.456'), 3723.456);
assert.strictEqual(parseTimecode('00:03,200'), 3.2);
assert.strictEqual(parseTimecode('99:99.000'), null);
assert.strictEqual(formatTimecode(3.2), '00:03.200');
assert.strictEqual(formatTimecode(3723.456), '01:02:03.456');
ok('时间码解析/格式化');

// ---------- VTT 往返 ----------
const vtt = `WEBVTT

NOTE 请保留我

1
00:00.000 --> 00:02.500 line:90% position:50% align:middle
第一行
<b>第二行</b>

2
00:02.600 --> 00:05.000
你好
`;
const parsed = parseVTT(vtt);
assert.ok(!parsed.error, parsed.error);
assert.strictEqual(parsed.cues.length, 2);
assert.strictEqual(parsed.cues[0].identifier, '1');
assert.strictEqual(parsed.cues[0].settings, 'line:90% position:50% align:middle');
assert.strictEqual(parsed.cues[0].text, '第一行\n<b>第二行</b>');
assert.ok(parsed.preamble.some((p) => p.includes('请保留我')));
const out = serializeVTT(parsed.cues, parsed.preamble);
assert.ok(out.startsWith('WEBVTT\n'));
assert.ok(out.includes('NOTE 请保留我'));
assert.ok(out.includes('line:90% position:50% align:middle'));
assert.ok(out.includes('<b>第二行</b>'));
assert.ok(out.includes('00:00.000 --> 00:02.500'));
const reparsed = parseVTT(out);
assert.strictEqual(reparsed.cues.length, 2);
ok('VTT 解析/序列化保留文本、设置、标识符、NOTE');

// ---------- 求解器 ----------
const GAP = 0.1, MIN = 1;

// 1. 向右移动：推动后续片段，保持时长与间隔
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [1, 3]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [3.1, 5]);
  ok('右移推动后续片段');
}

// 2. 向右移动空间充足时不影响更远的片段
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 5, e: 6 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [5, 6]);
  ok('空间充足时不推动');
}

// 3. 撞锁定片段，中间片段可压缩吸收 => 可行
{
  // a [0,3] b [3.1,6] dur 2.9 ; locked c [6.1,8]
  // a 右缘目标 4.9：b 刚性到 [5.0,7.9] 撞 c(6.1) => 压缩 b 为 [5.0,6.0]（dur 1）恰好可行
  const cs = mk([{ id: 'a', s: 0, e: 3 }, { id: 'b', s: 3.1, e: 6 }, { id: 'c', s: 6.1, e: 8, l: true }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1.9, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  const b = get(r.cues, 'b'), c = get(r.cues, 'c'), a = get(r.cues, 'a');
  assert.strictEqual(b.end - b.start >= 1 - 1e-6, true);
  assert.strictEqual(c.start, 6.1); // 锁定不动
  assert.strictEqual(b.end + GAP <= c.start + 1e-6, true);
  assert.strictEqual(a.end + GAP <= b.start + 1e-6, true);
  ok('撞锁定片段时中间片段压缩吸收');
}

// 3b. 同上场景，再多压一点即无解
{
  const cs = mk([{ id: 'a', s: 0, e: 3 }, { id: 'b', s: 3.1, e: 6 }, { id: 'c', s: 6.1, e: 8, l: true }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 2, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  assert.strictEqual(get(r.cues, 'c').start, 6.1);
  ok('压缩到极限后再多拖 => 无解');
}

// 4. 撞锁定片段且无法压缩 => 无解，冲突区间含锁定片段
{
  const cs = mk([{ id: 'a', s: 0, e: 3 }, { id: 'b', s: 3.1, e: 4.2 }, { id: 'c', s: 4.3, e: 8, l: true }]);
  // a 右缘目标 5.5：b 最多压到 [3.2,4.2](dur1)，边界 4.1；5.5>4.1 无解
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 2.5, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflict);
  assert.strictEqual(get(r.cues, 'c').start, 4.3);
  ok('锁定阻挡且压缩不足 => 无解');
}

// 5. 向左移动推动前方片段（a 压缩到最小时长）
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: 1.1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [1.1, 3]);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 1]);
  ok('左移推动并压缩前方片段');
}

// 5b. 向左移动、间隔仍充足时不影响前方片段
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 3, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: 2.4, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 2]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [2.4, 3.4]);
  ok('左移间隔充足时不推动');
}

// 5c. 向左移动碰到前方片段后刚性平移
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: 1.6, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  // a 刚性平移到 [-0.5,1.5] 后撞墙，压缩吸收为 [0,1.5]（仍满足 gap）；b = [1.6,3.5]
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 1.5]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [1.6, 3.5]);
  ok('左移刚性平移，越墙部分被吸收');
}

// 6. 向左越界 => 无解
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: -1.5, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflict!.range[0] === 0);
  ok('向左超出 0s => 无解');
}

// 7. 左侧锁定片段阻挡，中间压缩可吸收 => 可行
{
  // L [0,2] locked; b [2.1,5]; c[5.1,7] 目标 c.start=3
  // b 刚性: end<=2.9 => [0,2.9]? 撞 L: end<=1.9 => 压缩 b start>=2.1(L.end+gap) dur>=1 => end>=3.1
  // c.start=3 <= 3.1+0.1=3.2? 需要 leftBound(3.2) <= 3 => 无解！改成 desired 3.2
  const cs = mk([{ id: 'L', s: 0, e: 2, l: true }, { id: 'b', s: 2.1, e: 5 }, { id: 'c', s: 5.1, e: 7 }]);
  const r = applyDrag({ cues: cs, targetId: 'c', op: 'move', desired: 3.2, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  const b = get(r.cues, 'b');
  assert.strictEqual(b.start, 2.1);
  assert.strictEqual(Math.abs(b.end - 3.1) < 1e-6, true);
  assert.strictEqual(get(r.cues, 'L').end, 2);
  ok('左侧锁定 + 中间压缩可行');
}

// 8. resize-end 向右推动后续
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'resize-end', desired: 3.5, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 3.5]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [3.6, 5.5]);
  ok('右边界拖动推动后续');
}

// 9. resize 短于最小时长 => 无解
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'resize-end', desired: 0.5, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  ok('短于最小时长 => 无解');
}

// 10. 锁定目标不可拖（视为无变化可行）
{
  const cs = mk([{ id: 'a', s: 0, e: 2, l: true }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 5, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.strictEqual(get(r.cues, 'a').start, 0);
  ok('锁定片段自身不移动');
}

// 11. 连续三个片段链式推移，末端开放 => 全部平移，时长保持
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }, { id: 'c', s: 4.1, e: 6 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [3.1, 5]);
  assert.deepStrictEqual([get(r.cues, 'c').start, get(r.cues, 'c').end], [5.1, 7]);
  ok('链式刚性推移');
}

// 12. 原始 baseline 不被修改（撤销语义依赖快照）
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const snapshot = JSON.parse(JSON.stringify(cs));
  applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 9, minDuration: MIN, minGap: GAP });
  assert.deepStrictEqual(cs, snapshot);
  ok('输入数组不被原地修改');
}

// ---------- 画面布局：cue 设置编辑 ----------

// 13. 编辑四个布局字段时保留未知设置的原始顺序与内容
{
  const src = 'vertical:rl line:10% foo:bar position:20%';
  // 就地替换，位置不变
  assert.strictEqual(updateCueSetting(src, 'line', '90%'), 'vertical:rl line:90% foo:bar position:20%');
  // 不存在的字段追加到末尾
  assert.strictEqual(updateCueSetting(src, 'size', '80%'), 'vertical:rl line:10% foo:bar position:20% size:80%');
  // 置空即删除，其它设置原样保留
  assert.strictEqual(updateCueSetting(src, 'position', ''), 'vertical:rl line:10% foo:bar');
  // 同名重复设置：替换第一个并移除后续重复项
  assert.strictEqual(updateCueSetting('line:10% line:20% align:left', 'line', '50%'), 'line:50% align:left');
  // 空设置串上新增 / 删除唯一字段
  assert.strictEqual(updateCueSetting('', 'align', 'center'), 'align:center');
  assert.strictEqual(updateCueSetting('align:center', 'align', ''), '');
  // 读取与往返
  assert.strictEqual(getCueSetting(src, 'line'), '10%');
  assert.strictEqual(getCueSetting(src, 'size'), '');
  assert.strictEqual(serializeCueSettings(parseCueSettings(src)), src);
  ok('布局字段编辑保留未知设置的顺序与内容');
}

// 14. 布局字段取值校验
{
  assert.strictEqual(validateLayoutValue('line', '90%'), null);
  assert.strictEqual(validateLayoutValue('line', '12'), null);
  assert.strictEqual(validateLayoutValue('line', '-1,end'), null);
  assert.ok(validateLayoutValue('line', '120%') !== null);
  assert.ok(validateLayoutValue('line', 'abc') !== null);
  assert.strictEqual(validateLayoutValue('position', '50%,line-right'), null);
  assert.ok(validateLayoutValue('position', '50') !== null);
  assert.strictEqual(validateLayoutValue('size', '80%'), null);
  assert.ok(validateLayoutValue('size', '0.5') !== null);
  assert.strictEqual(validateLayoutValue('align', 'center'), null);
  assert.ok(validateLayoutValue('align', 'middle') !== null);
  ok('布局字段取值校验');
}

// 15. 字幕框几何与安全区检测
{
  // 显式 size：按 cue 框计算；line:90%,end 表示框底对齐 90%
  const a = analyzeCueLayout({ settings: 'line:90%,end position:50% size:80% align:center', text: '测试' });
  assert.ok(Math.abs(a.left - 10) < 1e-6 && Math.abs(a.width - 80) < 1e-6);
  assert.ok(Math.abs(a.top - (90 - 5.33)) < 1e-6 && Math.abs(a.height - 5.33) < 1e-6);
  assert.strictEqual(a.errors.length, 0);
  assert.strictEqual(a.outsideSafe, false); // 底边 90%，在容差内

  // line 默认 start 对齐：line:95% => 框顶在 95%，底边越界
  const b = analyzeCueLayout({ settings: 'line:95%', text: '测试文本' });
  assert.strictEqual(b.hasGeometry, true);
  assert.strictEqual(b.outsideSafe, true);
  assert.ok(b.safeViolations.some((v) => v.startsWith('下侧')));

  // position 对齐缺省时按 align 推导：align:right => 框右缘对齐 position
  const c = analyzeCueLayout({ settings: 'position:80% size:40% align:right', text: 'x' });
  assert.ok(Math.abs(c.left - 40) < 1e-6 && Math.abs(c.width - 40) < 1e-6);

  // 无显式几何 => 不做安全区判定；非法 align 进入 errors
  const d = analyzeCueLayout({ settings: 'align:middle', text: 'x' });
  assert.strictEqual(d.hasGeometry, false);
  assert.strictEqual(d.errors.length, 1);
  ok('字幕框几何与安全区检测');
}

// 16. 问题清单包含布局问题（非法值 + 超出安全区），且为警告、可定位到片段
{
  const cs: Cue[] = [
    { id: 'x', identifier: '', start: 0, end: 2, text: '你好', settings: 'align:middle line:95%', locked: false },
    { id: 'y', identifier: '', start: 3, end: 5, text: '世界', settings: '', locked: false },
  ];
  const st: Settings = { minDuration: 1, minGap: 0.1 };
  const iss = detectIssues(cs, st);
  const layout = iss.filter((i) => i.kind === 'layout');
  assert.strictEqual(layout.length, 2);
  assert.ok(layout.every((i) => i.severity === 'warning'));
  assert.ok(layout.every((i) => i.cueIds[0] === 'x'));
  assert.ok(layout.some((i) => i.message.includes('非法')));
  assert.ok(layout.some((i) => i.message.includes('安全区')));
  // 无布局问题的片段不产生 layout 条目
  assert.ok(!layout.some((i) => i.cueIds[0] === 'y'));
  ok('问题清单包含布局非法值与安全区越界');
}

// 17. 布局编辑后导出：未知 cue 设置顺序与内容保留
{
  const v = `WEBVTT

1
00:00.000 --> 00:02.000 vertical:rl line:10% foo:bar
你好
`;
  const p = parseVTT(v);
  assert.ok(!p.error, p.error);
  const c = p.cues[0];
  const updated = updateCueSetting(c.settings, 'position', '40%');
  const out = serializeVTT([{ ...c, settings: updated }], p.preamble);
  assert.ok(out.includes('vertical:rl line:10% foo:bar position:40%'));
  // 时序导出行为不变
  assert.ok(out.includes('00:00.000 --> 00:02.000'));
  ok('导出时未知 cue 设置顺序与内容保留');
}

// ---------- 两点同步 ----------

// 18. 基本线性映射：闭区间内未锁定片段全部变换，区间外不变
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 3, e: 5 }, { id: 'c', s: 6, e: 8 }, { id: 'd', s: 20, e: 22 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'c', newStartA: 10, newStartB: 14, minDuration: 1, minGap: 0.1 });
  assert.ok(r.feasible, r.conflicts.map((x) => x.reason).join('；'));
  // scale = (14-10)/(6-0) = 2/3，offset = 10
  assert.ok(Math.abs(r.scale - 2 / 3) < 1e-9);
  assert.ok(Math.abs(r.offset - 10) < 1e-9);
  assert.deepStrictEqual([...r.affectedIds].sort(), ['a', 'b', 'c']);
  const b = get(r.cues, 'b');
  assert.ok(Math.abs(b.start - 12) < 1e-6 && Math.abs(b.end - 40 / 3) < 1e-6);
  const a2 = get(r.cues, 'a');
  assert.ok(Math.abs(a2.start - 10) < 1e-6 && Math.abs(a2.end - 34 / 3) < 1e-6);
  const d = get(r.cues, 'd');
  assert.deepStrictEqual([d.start, d.end], [20, 22]);
  ok('两点同步：线性映射变换闭区间内片段，区间外不变');
}

// 19. 区间内锁定片段保持不变；与其碰撞 => 禁止应用且不部分写入
{
  const cs = mk([{ id: 'a', s: 10, e: 12 }, { id: 'L', s: 12.1, e: 14, l: true }, { id: 'b', s: 14.1, e: 16 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 10, newStartB: 13, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts.length >= 1);
  assert.ok(r.conflicts.some((c) => c.cueIds.includes('L')));
  // 不部分写入：返回的 cues 与原始一致
  assert.strictEqual(get(r.cues, 'a').start, 10);
  assert.strictEqual(get(r.cues, 'b').start, 14.1);
  assert.strictEqual(get(r.cues, 'L').start, 12.1);
  ok('两点同步：锁定片段不变，冲突时禁止应用且不部分写入');
}

// 20. 新旧锚点顺序无效均被拒绝
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 5, e: 7 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 10, newStartB: 9, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts[0].reason.includes('顺序'));
  // 锚点先后颠倒（锚点 1 晚于锚点 2）同样无效
  const r2 = planTwoPointSync({ cues: cs, anchorAId: 'b', anchorBId: 'a', newStartA: 5, newStartB: 6, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r2.feasible, false);
  assert.ok(r2.conflicts[0].reason.includes('顺序'));
  ok('两点同步：新旧锚点顺序无效均被拒绝');
}

// 21. 变换后时长低于当前最小时长 => 禁止并列出冲突片段
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 10, e: 12 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 0, newStartB: 4, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts.some((c) => c.reason.includes('时长') && c.cueIds.includes('a')));
  assert.ok(r.conflicts.some((c) => c.reason.includes('时长') && c.cueIds.includes('b')));
  ok('两点同步：变换后时长低于最小时长被拒绝');
}

// 22. 区间边界相邻片段间隔不足 => 禁止并列出两侧片段
{
  const cs = mk([{ id: 'x', s: 0, e: 1 }, { id: 'a', s: 2, e: 4 }, { id: 'b', s: 8, e: 10 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 1.05, newStartB: 7.05, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts.some((c) => c.cueIds.includes('x') && c.cueIds.includes('a')));
  ok('两点同步：区间边界相邻片段间隔不足被拒绝');
}

// 23. 校准后不得早于时间轴起点
{
  const cs = mk([{ id: 'a', s: 1, e: 2 }, { id: 'b', s: 5, e: 6 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: -0.5, newStartB: 3.5, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts.some((c) => c.reason.includes('00:00')));
  ok('两点同步：校准后早于 00:00.000 被拒绝');
}

// 24. 锚点必须未锁定且互不相同
{
  const cs = mk([{ id: 'a', s: 0, e: 2, l: true }, { id: 'b', s: 5, e: 7 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 0, newStartB: 5, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts[0].reason.includes('锁定'));
  const r2 = planTwoPointSync({ cues: cs, anchorAId: 'b', anchorBId: 'b', newStartA: 0, newStartB: 5, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r2.feasible, false);
  ok('两点同步：锚点必须未锁定且互不相同');
}

// 25. 可行时区间内锁定片段保持不动，输入数组不被原地修改
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'L', s: 2.5, e: 3.5, l: true }, { id: 'b', s: 4, e: 6 }]);
  const snapshot = JSON.parse(JSON.stringify(cs));
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 0.4, newStartB: 4.4, minDuration: 1, minGap: 0.1 });
  assert.ok(r.feasible, r.conflicts.map((x) => x.reason).join('；'));
  assert.deepStrictEqual([get(r.cues, 'L').start, get(r.cues, 'L').end], [2.5, 3.5]);
  assert.ok(Math.abs(get(r.cues, 'a').start - 0.4) < 1e-6);
  assert.ok(Math.abs(get(r.cues, 'b').start - 4.4) < 1e-6);
  assert.deepStrictEqual(cs, snapshot);
  ok('两点同步：可行时锁定片段不动，输入不被修改');
}

// 26. 恒等映射可识别（面板据此禁用应用）
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 5, e: 7 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 0, newStartB: 5, minDuration: 1, minGap: 0.1 });
  assert.ok(r.feasible);
  assert.strictEqual(r.identity, true);
  assert.deepStrictEqual(r.affectedIds.sort(), ['a', 'b']);
  ok('两点同步：恒等映射可识别');
}

// ---------- 合并双语轨 ----------

interface MCue { s: number; e: number; text?: string }
function mkm(spec: MCue[]): Cue[] {
  return spec.map((c, i) => ({
    id: `m${i}`, identifier: '', start: c.s, end: c.e,
    text: c.text ?? `M${i}`, settings: '', locked: false,
  }));
}
function mks(spec: MCue[]): Cue[] {
  return spec.map((c, i) => ({
    id: `s${i}`, identifier: '', start: c.s, end: c.e,
    text: c.text ?? `S${i}`, settings: '', locked: false,
  }));
}

// 27. 基本配对：完全重叠的片段一一配对，总交集为时长之和
{
  const plan = planMerge(mkm([{ s: 0, e: 4 }, { s: 5, e: 9 }]), mks([{ s: 0, e: 4 }, { s: 5, e: 9 }]));
  assert.strictEqual(plan.candidates.length, 2);
  assert.strictEqual(plan.pairs.length, 2);
  assert.deepStrictEqual(plan.pairs.map((p) => [p.primaryIndex, p.secondaryIndex]), [[0, 0], [1, 1]]);
  assert.ok(Math.abs(plan.totalOverlap - 8) < 1e-9);
  assert.deepStrictEqual(plan.unmatchedPrimary, []);
  assert.deepStrictEqual(plan.unmatchedSecondary, []);
  ok('双语合并：完全重叠片段一一配对');
}

// 28. 候选阈值：交集 / 较短片段时长 < 50% 排除；恰为 50% 保留
{
  // 主 [0,3] 时长3，副 [2,10] 时长8，交集 1s，较短3s => 33% 排除
  const plan1 = planMerge(mkm([{ s: 0, e: 3 }]), mks([{ s: 2, e: 10 }]));
  assert.strictEqual(plan1.candidates.length, 0);
  assert.strictEqual(plan1.pairs.length, 0);
  assert.deepStrictEqual(plan1.unmatchedPrimary, [0]);
  assert.deepStrictEqual(plan1.unmatchedSecondary, [0]);

  // 主 [0,4]，副 [2,10]，交集 2s，较短4s => 恰好 50% 保留
  const plan2 = planMerge(mkm([{ s: 0, e: 4 }]), mks([{ s: 2, e: 10 }]));
  assert.strictEqual(plan2.candidates.length, 1);
  assert.strictEqual(plan2.pairs.length, 1);
  assert.ok(Math.abs(plan2.pairs[0].overlap - 2) < 1e-9);

  // 仅端点接触（交集 0）不算候选
  const plan3 = planMerge(mkm([{ s: 0, e: 4 }]), mks([{ s: 4, e: 8 }]));
  assert.strictEqual(plan3.candidates.length, 0);
  ok('双语合并：50% 阈值（边界含）与零交集排除');
}

// 29. 每条最多使用一次、保持顺序、总交集最大
{
  // 长副轨 s0[0,8] 与两条主轨各相交，但只能使用一次；取权重更大的一对
  const plan = planMerge(mkm([{ s: 0, e: 4 }, { s: 4.1, e: 8 }]), mks([{ s: 0, e: 8 }]));
  assert.strictEqual(plan.pairs.length, 1);
  assert.strictEqual(plan.pairs[0].primaryIndex, 0);
  assert.strictEqual(plan.pairs[0].secondaryIndex, 0);
  assert.ok(Math.abs(plan.pairs[0].overlap - 4) < 1e-9);
  assert.deepStrictEqual(plan.unmatchedPrimary, [1]);

  // 交叉配对比顺序配对差时，DP 取保持双方顺序的方案：
  // 主 [0,4]/[6,10]，副 s0[0,4]/s1[6,10]，另一个夹在中间的主 [3,7]
  // 与两条副轨各只相交 1s（25%），不成候选；最优仍是两端同序两对
  const plan2 = planMerge(
    mkm([{ s: 0, e: 4 }, { s: 3, e: 7 }, { s: 6, e: 10 }]),
    mks([{ s: 0, e: 4 }, { s: 6, e: 10 }]),
  );
  assert.strictEqual(plan2.pairs.length, 2);
  assert.deepStrictEqual(plan2.pairs.map((p) => [p.primaryIndex, p.secondaryIndex]), [[0, 0], [2, 1]]);
  assert.deepStrictEqual(plan2.unmatchedPrimary, [1]);
  ok('双语合并：每条最多一次、保持顺序、总交集最大');
}

// 30. 总分并列时取副轨索引序列字典序更小方案
{
  // 两条完全相同的副轨 s1/s2 都与主 p1 完全重叠（各 4s），取副轨索引更小者
  const plan = planMerge(
    mkm([{ s: 0, e: 4 }, { s: 4.1, e: 8 }]),
    mks([{ s: 0, e: 4 }, { s: 4.1, e: 8 }, { s: 4.1, e: 8 }]),
  );
  // 最优：(p0,s0)=4 + (p1,s1)=4，序列 [0,1]；而不是 [0,2]
  assert.strictEqual(plan.pairs.length, 2);
  assert.deepStrictEqual(plan.pairs.map((p) => p.secondaryIndex), [0, 1]);
  assert.deepStrictEqual(plan.unmatchedSecondary, [2]);

  // 单条主轨同时与两条相同副轨等权：取副轨 #1
  const plan2 = planMerge(mkm([{ s: 0, e: 4 }]), mks([{ s: 0, e: 4 }, { s: 0, e: 4 }]));
  assert.strictEqual(plan2.pairs.length, 1);
  assert.strictEqual(plan2.pairs[0].secondaryIndex, 0);
  assert.deepStrictEqual(plan2.unmatchedSecondary, [1]);
  ok('双语合并：并列时副轨索引序列字典序更小');
}

// 30b. 决胜回归：首个副轨相同、所选主轨不同会产生不同后续副轨序列
{
  // 候选：(P0,S0)=1、(P1,S0)=4、(P1,S1)=2、(P1,S2)=5、(P2,S1)=2，最优总分 6。
  // 两个最优方案的首对副轨都是 S0：
  //   选最小主轨 P0 => 后缀只能配 S2，副轨序列 [0,2]（旧实现的错误输出）；
  //   选主轨 P1     => 后缀可配 S1，副轨序列 [0,1]（全局字典序最小）。
  // 决胜必须比较各可行后缀，不能因 P0 主轨索引更小就直接固定它。
  const plan = planMerge(
    mkm([{ s: 0, e: 1 }, { s: 0, e: 13 }, { s: 5, e: 7 }]),
    mks([{ s: 0, e: 4 }, { s: 5, e: 7 }, { s: 8, e: 14 }]),
  );
  assert.strictEqual(plan.candidates.length, 5);
  assert.ok(Math.abs(plan.totalOverlap - 6) < 1e-9);
  assert.deepStrictEqual(
    plan.pairs.map((p) => [p.primaryIndex, p.secondaryIndex]),
    [[1, 0], [2, 1]],
  );
  assert.deepStrictEqual(plan.pairs.map((p) => p.secondaryIndex), [0, 1]);
  assert.deepStrictEqual(plan.unmatchedPrimary, [0]);
  assert.deepStrictEqual(plan.unmatchedSecondary, [2]);
  // 确定性：相同输入重复求解，配对结果完全一致
  const again = planMerge(
    mkm([{ s: 0, e: 1 }, { s: 0, e: 13 }, { s: 5, e: 7 }]),
    mks([{ s: 0, e: 4 }, { s: 5, e: 7 }, { s: 8, e: 14 }]),
  );
  assert.deepStrictEqual(
    again.pairs.map((p) => [p.primaryIndex, p.secondaryIndex]),
    [[1, 0], [2, 1]],
  );
  ok('双语合并：首个副轨相同、主轨选择影响后续副轨序列时取全局字典序最小（确定性）');
}

// 31. 输入不被修改；确认语义：副轨文本作为新一行追加，主轨字段原样保留
{
  const main = mkm([{ s: 0, e: 4, text: '你好' }]);
  main[0].identifier = 'cid-1';
  main[0].settings = 'line:90% align:middle';
  main[0].locked = true;
  const sub = mks([{ s: 0, e: 4, text: 'Hello' }]);
  const snapshot = JSON.parse(JSON.stringify([main, sub]));
  const plan = planMerge(main, sub);
  assert.deepStrictEqual([main, sub], snapshot);
  assert.strictEqual(joinBilingualText(main[0].text, sub[0].text), '你好\nHello');
  // 多行文本各自去尾空白后拼接
  assert.strictEqual(joinBilingualText('A\n', 'B\n\n'), 'A\nB');

  // 模拟确认写入：只改 text，start/end/identifier/settings/locked 原样保留
  const pair = plan.pairs[0];
  const applied = main.map((c) =>
    c.id === plan.primary[pair.primaryIndex].id
      ? { ...c, text: joinBilingualText(c.text, plan.secondary[pair.secondaryIndex].text) }
      : c,
  );
  assert.strictEqual(applied[0].text, '你好\nHello');
  assert.strictEqual(applied[0].start, 0);
  assert.strictEqual(applied[0].end, 4);
  assert.strictEqual(applied[0].identifier, 'cid-1');
  assert.strictEqual(applied[0].settings, 'line:90% align:middle');
  assert.strictEqual(applied[0].locked, true);
  // 未配对副轨不出现在写入结果中（无任何主轨文本包含它）
  assert.ok(!applied.some((c) => c.text.includes('未写入')));
  ok('双语合并：输入不变；确认仅追加文本行，时间/标识符/设置/锁定保留');
}

// ---------- 片段摘录导出 ----------

// 32. 正时长交集纳入并统一减去摘录起点；仅端点相接排除；时间范围无效报错
{
  const cs = mk([
    { id: 'a', s: 0, e: 2 },     // 左邻
    { id: 'b', s: 2, e: 5 },     // 与 a 仅端点相接；与区间在 5 处相接
    { id: 'c', s: 5, e: 8 },
    { id: 'd', s: 10, e: 12 },   // 区间外
  ]);
  const plan = planExcerpt(cs, 2, 5);
  assert.strictEqual(plan.error, null);
  assert.deepStrictEqual(plan.cues.map((c) => c.id), ['b']);
  assert.strictEqual(plan.cues[0].start, 0);
  assert.strictEqual(plan.cues[0].end, 3);
  // b 在 [2,5] 与区间完全重合；a 在 2 处仅端点相接、c 在 5 处仅端点相接，均不纳入
  assert.strictEqual(plan.cues.some((c) => c.id === 'a' || c.id === 'c'), false);

  // 结束不晚于开始 => 无效
  const bad1 = planExcerpt(cs, 5, 5);
  assert.ok(bad1.error && bad1.cues.length === 0);
  const bad2 = planExcerpt(cs, 6, 4);
  assert.ok(bad2.error);
  const bad3 = planExcerpt(cs, -1, 4);
  assert.ok(bad3.error);

  // 区间有效但无正时长交集
  const none = planExcerpt(cs, 8, 10);
  assert.strictEqual(none.error, null);
  assert.strictEqual(none.cues.length, 0); // c 在 8 处相接、d 在 10 处相接
  ok('摘录：左闭右开正时长交集，端点相接排除；无效/无命中');
}

// 33. cue 起止被裁到交集后再偏移（左右裁剪）
{
  const cs: Cue[] = [
    { id: 'a', identifier: '', start: 0, end: 10, text: 'A', settings: '', locked: false },
    { id: 'b', identifier: '', start: 3, end: 4, text: 'B', settings: '', locked: false },
  ];
  const plan = planExcerpt(cs, 3, 7);
  assert.strictEqual(plan.cues.length, 2);
  // a 裁到 [3,7]，偏移后 [0,4]
  const a = plan.cues[0];
  assert.ok(Math.abs(a.start - 0) < 1e-9 && Math.abs(a.end - 4) < 1e-9);
  assert.deepStrictEqual([a.origStart, a.origEnd], [0, 10]);
  // b 完全在区间内：[3,4] -> [0,1]
  const b = plan.cues[1];
  assert.ok(Math.abs(b.start - 0) < 1e-9 && Math.abs(b.end - 1) < 1e-9);

  // 起点非零的偏移
  const plan2 = planExcerpt(cs, 5, 7);
  assert.strictEqual(plan2.cues.length, 1);
  const a2 = plan2.cues[0];
  assert.deepStrictEqual([a2.start, a2.end], [0, 2]);
  ok('摘录：cue 起止裁到交集并统一减去摘录起点');
}

// 34. 时间戳标签：仅保留落在裁剪后 cue 内部的标签并按同一偏移改写；
//     恰好落在裁剪右端点的标签随左闭右开被删除；普通内联标签/文字保留
{
  const text = '<00:01.000><b>早</b><00:03.000>中间<00:05.000><i>晚</i><00:09.000>尾';
  // cue 原始 [0,10]，摘录 [2,8] => cue 裁到 [2,8]，偏移 -2 => [0,6]
  const out = rewriteTimestampTags(text, 2, 8, 2);
  // 1.000 < 2 删除；3.000 -> 00:01.000；5.000 -> 00:03.000；9.000 > 8 删除
  assert.strictEqual(out, '<b>早</b><00:01.000>中间<00:03.000><i>晚</i>尾');

  // 标签恰好落在右端点 8.000：左闭右开，不保留
  const edge = rewriteTimestampTags('<00:08.000>x', 2, 8, 2);
  assert.strictEqual(edge, 'x');
  // 标签恰好落在左端点 2.000：保留并归零
  const edgeL = rewriteTimestampTags('<00:02.000>x', 2, 8, 2);
  assert.strictEqual(edgeL, '<00:00.000>x');

  // 非时间戳的尖括号内容原样保留（<00:00> 缺毫秒、<v Bob> 等）
  const weird = rewriteTimestampTags('<00:00><v Bob>你好</v>', 0, 8, 0);
  assert.strictEqual(weird, '<00:00><v Bob>你好</v>');
  ok('摘录：时间戳标签按左闭右开裁剪并偏移改写，其余内联标签保留');
}

// 35. 端到端：摘录结果可直接序列化，标识符/设置/文件头原样保留，时间码归零
{
  const vtt = `WEBVTT

NOTE 保留头

cid-7
00:04.000 --> 00:12.000 line:90% align:middle
<00:05.000>你好<00:09.500>世界

00:20.000 --> 00:22.000
区间外
`;
  const p = parseVTT(vtt);
  assert.ok(!p.error, p.error);
  const plan = planExcerpt(p.cues, 6, 10);
  assert.strictEqual(plan.cues.length, 1);
  const c = plan.cues[0];
  assert.deepStrictEqual([c.start, c.end], [0, 4]);
  // 5.000 在裁剪左端点之前被删；9.500 -> 3.500
  assert.strictEqual(c.text, '你好<00:03.500>世界');
  const src = p.cues.find((x) => x.id === c.id)!;
  const out = serializeVTT(
    [{ ...src, start: c.start, end: c.end, text: c.text }],
    p.preamble,
  );
  assert.ok(out.includes('NOTE 保留头'));
  assert.ok(out.includes('cid-7'));
  assert.ok(out.includes('00:00.000 --> 00:04.000 line:90% align:middle'));
  assert.ok(out.includes('你好<00:03.500>世界'));
  assert.ok(!out.includes('区间外'));
  const reparsed = parseVTT(out);
  assert.ok(!reparsed.error, reparsed.error);
  assert.strictEqual(reparsed.cues.length, 1);
  ok('摘录：序列化保留文件头/标识符/设置，时间码归零，区间外 cue 不写入');
}

// 36. 摘录不修改输入 cue（当前编辑内容不变）
{
  const cs: Cue[] = [
    { id: 'a', identifier: 'id-a', start: 0, end: 10, text: '<00:01.000>x', settings: 'line:50%', locked: true },
  ];
  const snapshot = JSON.parse(JSON.stringify(cs));
  const plan = planExcerpt(cs, 2, 8);
  assert.deepStrictEqual(cs, snapshot);
  assert.strictEqual(plan.cues[0].text, 'x');
  assert.strictEqual(cs[0].text, '<00:01.000>x');
  assert.strictEqual(cs[0].start, 0);
  assert.strictEqual(cs[0].locked, true);
  ok('摘录：输入 cue 与文本不被修改');
}

// ---------- 智能分行 ----------

function cueObj(id: string, text: string, locked = false): Cue {
  return { id, identifier: '', start: 0, end: 2, text, settings: '', locked };
}

// 37. 行宽：中文及全角计 2、其余计 1；标签/时间戳标签不计；行缘空白不计
{
  assert.strictEqual(visibleWidth('你好'), 4);
  assert.strictEqual(visibleWidth('ab'), 2);
  assert.strictEqual(visibleWidth('ＡＢ'), 4); // 全角 ASCII（FF21/FF22）
  assert.strictEqual(visibleWidth('<b>你好</b>'), 4);
  assert.strictEqual(visibleWidth('<v Bob>你好</v>'), 4);
  assert.strictEqual(visibleWidth('<00:01.500>你好'), 4); // 时间戳标签不计宽
  assert.strictEqual(visibleWidth('a b'), 3); // 内部空格计 1
  assert.strictEqual(visibleWidth('ab '), 2); // 行尾空白不计
  assert.strictEqual(visibleWidth('  ab'), 2); // 行首空白不计
  assert.strictEqual(visibleWidth('你好，世界'), 10);
  ok('智能分行：可见字素宽度（标签不计、行缘空白不计）');
}

// 38. 两行断点：优先最小化两行宽差（等宽差时取位置靠前者）
{
  const r = suggestWrap('大家好欢迎收看本期节目', 12); // 11 个宽字素，共 22
  assert.strictEqual(r.ok, true);
  if (r.ok) {
    assert.strictEqual(r.suggestion.text, '大家好欢迎\n收看本期节目'); // 10 + 12
    assert.deepStrictEqual(r.suggestion.lineWidths, [10, 12]);
  }
  ok('智能分行：优先减少两行宽差');
}

// 39. 空格处断行优先；空格保留在行尾（不删除任何字符）
{
  const r = suggestWrap('hello world', 8);
  assert.strictEqual(r.ok, true);
  if (r.ok) {
    assert.strictEqual(r.suggestion.text, 'hello \nworld');
    assert.deepStrictEqual(r.suggestion.lineWidths, [5, 5]);
  }
  // 连续空白只在整个空白 run 之后断（第二行不以空白开头）
  const r2 = suggestWrap('aa  bb', 3);
  assert.strictEqual(r2.ok, true);
  if (r2.ok) assert.strictEqual(r2.suggestion.text, 'aa  \nbb');
  ok('智能分行：空格断点优先且空白保留');
}

// 40. 闭合标点不得出现在行首（断点必须在标点之后）
{
  const r = suggestWrap('你好，世界啊', 7); // 共 12
  assert.strictEqual(r.ok, true);
  if (r.ok) {
    assert.strictEqual(r.suggestion.text, '你好，\n世界啊'); // 6 + 6
    assert.ok(!r.suggestion.text.split('\n')[1].startsWith('，'));
  }
  ok('智能分行：闭合标点不出现在行首');
}

// 41. 开放标点不得出现在行尾
{
  const r = suggestWrap('他说《红楼》好', 8); // 共 14
  assert.strictEqual(r.ok, true);
  if (r.ok) {
    // 中点 6/8 会把「《」留在行尾（非法），合法最优为 8 + 6
    assert.strictEqual(r.suggestion.text, '他说《红\n楼》好');
    assert.deepStrictEqual(r.suggestion.lineWidths, [8, 6]);
    assert.ok(!r.suggestion.text.split('\n')[0].endsWith('《'));
  }
  ok('智能分行：开放标点不出现在行尾');
}

// 42. 内联标签与时间戳标签不计宽、不可拆开，标签旁的禁则仍按可见字素判断
{
  const r = suggestWrap('<b>你好世界</b>', 5);
  assert.strictEqual(r.ok, true);
  if (r.ok) assert.strictEqual(r.suggestion.text, '<b>你好\n世界</b>');

  const r2 = suggestWrap('<00:01.000>你好世界', 5);
  assert.strictEqual(r2.ok, true);
  if (r2.ok) assert.strictEqual(r2.suggestion.text, '<00:01.000>你好\n世界');

  // 标签不拆开：<00:01.000> 始终完整出现
  const r3 = suggestWrap('你<00:01.000>好世界', 5);
  assert.strictEqual(r3.ok, true);
  if (r3.ok) {
    assert.strictEqual(r3.suggestion.text, '你<00:01.000>好\n世界');
    assert.strictEqual(r3.suggestion.text.includes('<00:01.000>'), true);
    assert.strictEqual(r3.suggestion.text.includes('<00:01'), true);
  }
  // 「</b>，世界」中，标签不掩盖其后闭合标点的禁则
  const r4 = suggestWrap('你好</b>，世界啊', 7);
  assert.strictEqual(r4.ok, true);
  if (r4.ok) {
    assert.strictEqual(r4.suggestion.text, '你好</b>，\n世界啊');
    assert.ok(!r4.suggestion.text.split('\n')[1].startsWith('，'));
  }
  ok('智能分行：标签原子且不计宽，禁则按可见字素判断');
}

// 43. 已满足约束（≤2 行且每行不超宽、断点合法）→ 保持原文
{
  const a = suggestWrap('短', 20);
  assert.strictEqual(a.ok && a.suggestion.text, '短');
  const b = suggestWrap('你好\n世界', 20);
  assert.strictEqual(b.ok && b.suggestion.text, '你好\n世界');
  const c = suggestWrap('ab\ncd', 20);
  assert.strictEqual(c.ok && c.suggestion.text, 'ab\ncd');

  // 既有某行超宽 → 重新规划：删除旧换行、在更优处增换行
  const d = suggestWrap('你好世界啊\n嗯', 6); // 共 12
  assert.strictEqual(d.ok, true);
  if (d.ok) assert.strictEqual(d.suggestion.text, '你好世\n界啊嗯');

  // 既有断点违反禁则 → 删除该断点（单行放得下时并为一行）
  const e = suggestWrap('你好\n，世界', 20);
  assert.strictEqual(e.ok, true);
  if (e.ok) assert.strictEqual(e.suggestion.text, '你好，世界');
  ok('智能分行：已满足保持原文，否则增删换行');
}

// 44. 单行即可放下时删除多余换行（如原文本超过两行）
{
  const r = suggestWrap('你好\n世界\n啊', 20);
  assert.strictEqual(r.ok, true);
  if (r.ok) {
    assert.strictEqual(r.suggestion.text, '你好世界啊');
    assert.deepStrictEqual(r.suggestion.lineWidths, [10, 0]);
  }
  ok('智能分行：单行放得下时删除多余换行');
}

// 45. 无解：超过两行
{
  const r = suggestWrap('哈'.repeat(20), 12); // 宽 40 > 2×12
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes('两行'));
  ok('智能分行：超过两行标出无解原因');
}

// 46. 无解：单字素超宽；ASCII 在字素边界可断
{
  const r = suggestWrap('你好', 1); // 宽字素宽度 2 > 1
  assert.strictEqual(r.ok, false);
  if (!r.ok) {
    assert.ok(r.reason.includes('字素'));
    assert.ok(r.reason.includes('你'));
  }
  const r2 = suggestWrap('ab', 1);
  assert.strictEqual(r2.ok, true);
  if (r2.ok) {
    assert.strictEqual(r2.suggestion.text, 'a\nb');
    assert.deepStrictEqual(r2.suggestion.lineWidths, [1, 1]);
  }
  ok('智能分行：单字素超宽标出原因，ASCII 按字素边界断');
}

// 47. 无解：标点禁则导致无合法断点
{
  const r = suggestWrap('（（', 2); // 唯一断点会把「（」留在行尾
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes('标点禁则'));
  ok('智能分行：标点禁则导致无合法断点');
}

// 48. 批量规划：只处理未锁定片段，分类正确，输入不被修改
{
  const cs: Cue[] = [
    cueObj('a', '大家好欢迎收看本期节目'),
    cueObj('b', '短'),
    cueObj('c', '哈'.repeat(20)), // 宽 40 > 2×12 无解
    cueObj('d', '锁定锁定锁定锁定锁定锁定', true), // 锁定：跳过
  ];
  const snapshot = JSON.parse(JSON.stringify(cs));
  const plan = planSmartWrap(cs, 12);
  assert.deepStrictEqual(plan.changes.map((x) => x.id), ['a']);
  assert.strictEqual(plan.changes[0].suggested, '大家好欢迎\n收看本期节目');
  assert.deepStrictEqual(plan.kept, ['b']);
  assert.deepStrictEqual(plan.failures.map((x) => x.id), ['c']);
  assert.ok(plan.failures[0].reason.includes('两行'));
  assert.strictEqual(plan.lockedSkipped, 1);
  assert.deepStrictEqual(cs, snapshot);
  ok('智能分行：批量仅处理未锁定片段，分类正确，输入不变');
}

// 49. 确认应用 + 导出往返：仅增删换行，其余字符/标签/时间码/cue 设置/标识符保留
{
  const v = `WEBVTT

NOTE 保留头

cid-9
00:01.000 --> 00:04.000 line:90% align:middle
他说《红楼》好
`;
  const p = parseVTT(v);
  assert.ok(!p.error, p.error);
  const plan = planSmartWrap(p.cues, 8);
  assert.strictEqual(plan.changes.length, 1);
  const applied = p.cues.map((c) =>
    c.id === plan.changes[0].id ? { ...c, text: plan.changes[0].suggested } : c,
  );
  const out = serializeVTT(applied, p.preamble);
  assert.ok(out.includes('NOTE 保留头'));
  assert.ok(out.includes('cid-9'));
  assert.ok(out.includes('00:01.000 --> 00:04.000 line:90% align:middle'));
  assert.ok(out.includes('他说《红\n楼》好'));
  const re = parseVTT(out);
  assert.ok(!re.error, re.error);
  assert.strictEqual(re.cues.length, 1);
  assert.strictEqual(re.cues[0].text, '他说《红\n楼》好');
  assert.strictEqual(re.cues[0].identifier, 'cid-9');
  assert.strictEqual(re.cues[0].settings, 'line:90% align:middle');
  assert.strictEqual(re.cues[0].start, 1);
  assert.strictEqual(re.cues[0].end, 4);
  ok('智能分行：应用后导出保留标识符/设置/时间码/文件头，换行写入且可往返');
}

// 50. 幂等性与确定性：建议文本再次规划保持不变，重复求解结果一致
{
  const cases: Array<[string, number]> = [
    ['大家好欢迎收看本期节目', 12],
    ['hello world', 8],
    ['他说《红楼》好', 8],
    ['<b>你好世界</b>', 5],
    ['你好世界啊\n嗯', 6],
  ];
  for (const [t, w] of cases) {
    const r1 = suggestWrap(t, w);
    const r3 = suggestWrap(t, w);
    assert.ok(r1.ok);
    assert.ok(r3.ok);
    if (r1.ok && r3.ok) {
      const r2 = suggestWrap(r1.suggestion.text, w);
      assert.ok(r2.ok);
      if (r2.ok) assert.strictEqual(r2.suggestion.text, r1.suggestion.text);
      assert.strictEqual(r3.suggestion.text, r1.suggestion.text);
    }
  }
  ok('智能分行：建议幂等且求解确定');
}

// ---------- 术语统一 ----------

function tcue(id: string, text: string, locked = false): Cue {
  return { id, identifier: '', start: 0, end: 2, text, settings: '', locked };
}

// 51. 基本替换：按可见文字替换、命中次数统计、未命中文字保留
{
  const r = applyTerminology('人工智能很好，人工智能', [{ from: '人工智能', to: 'AI' }]);
  assert.strictEqual(r.text, 'AI很好，AI');
  assert.strictEqual(r.hits, 2);
  assert.deepStrictEqual(r.ruleHits, [{ ruleIndex: 0, count: 2 }]);
  ok('术语统一：基本替换与命中计数');
}

// 52. 允许原词跨越内联格式标签，标签原文、顺序与位置语义保留
{
  // 标签只包裹命中首字素：替换后仍包裹替换词首字（相对位置按比例映射）
  const r = applyTerminology('<b>人</b>工智能', [{ from: '人工智能', to: 'AI' }]);
  assert.strictEqual(r.text, '<b>A</b>I');
  assert.strictEqual(r.hits, 1);

  // 标签夹在命中字素之间：按相对缝隙插入替换词对应位置（超出替换词长度则贴末尾）
  const r2 = applyTerminology('人<b>工</b>智能', [{ from: '人工智能', to: '机器' }]);
  assert.strictEqual(r2.text, '机<b>器</b>');

  // 命中范围外的标签与文字原样保留
  const r3 = applyTerminology('前缀<i>x</i>人工智能后缀', [{ from: '人工智能', to: 'AI' }]);
  assert.strictEqual(r3.text, '前缀<i>x</i>AI后缀');

  // 标签贴在命中外侧：<b>人工智能</b> 标签完整包裹替换词
  const r4 = applyTerminology('<b>人工智能</b>', [{ from: '人工智能', to: 'AI' }]);
  assert.strictEqual(r4.text, '<b>AI</b>');

  // 同一命中内多个内联标签顺序原样保留；超出替换词长度的缝隙贴末尾
  const r5 = applyTerminology('a人<b>工</b><i>智</i>能z', [{ from: '人工智能', to: '机器' }]);
  assert.strictEqual(r5.text, 'a机<b>器</b><i></i>z');
  ok('术语统一：跨越内联标签匹配并保留标签原文/顺序/位置');
}

// 53. 时间戳标签是匹配边界，原词不得跨越；标签原样保留
{
  const r = applyTerminology('<00:01.000>人工智能', [{ from: '人工智能', to: 'AI' }]);
  assert.strictEqual(r.text, '<00:01.000>AI'); // 标签之后的正文仍可命中

  // 标签把可见文字截断：跨标签的原词不命中，标签原样
  const r2 = applyTerminology('人工<00:01.000>智能', [{ from: '人工智能', to: 'AI' }]);
  assert.strictEqual(r2.text, '人工<00:01.000>智能');
  assert.strictEqual(r2.hits, 0);

  // 无法解析为时间戳的尖括号不是边界：<00:00> 缺毫秒，可跨越
  const r3 = applyTerminology('人工<00:00>智能', [{ from: '人工智能', to: 'AI' }]);
  assert.strictEqual(r3.text, 'AI<00:00>');
  assert.strictEqual(r3.hits, 1);
  ok('术语统一：时间戳标签为边界，非时间戳尖括号可跨越');
}

// 54. 换行也是匹配边界：不跨行匹配，换行原样保留
{
  const r = applyTerminology('人工\n智能', [{ from: '人工智能', to: 'AI' }]);
  assert.strictEqual(r.text, '人工\n智能');
  assert.strictEqual(r.hits, 0);

  const r2 = applyTerminology('人工智能\n人工智能', [{ from: '人工智能', to: 'AI' }]);
  assert.strictEqual(r2.text, 'AI\nAI');
  assert.strictEqual(r2.hits, 2);
  ok('术语统一：换行为匹配边界且原样保留');
}

// 55. 同位置多规则命中：最长原词优先，等长按输入顺序
{
  // 「人工智能」比「人工」更长，取长规则
  const r = applyTerminology('人工智能', [
    { from: '人工', to: 'X' },
    { from: '人工智能', to: 'AI' },
  ]);
  assert.strictEqual(r.text, 'AI');
  assert.deepStrictEqual(r.ruleHits, [{ ruleIndex: 1, count: 1 }]);

  // 等长：先输入者胜
  const r2 = applyTerminology('人工智能', [
    { from: '人工智能', to: '一' },
    { from: '人工智能', to: '二' },
  ]);
  assert.strictEqual(r2.text, '一');

  // 左起点处短词与稍后起点的长词：leftmost-longest —— 起点优先取该处最长
  const r3 = applyTerminology('人工智能', [
    { from: '人工', to: '短' },
    { from: '工智能', to: '更长词' },
  ]);
  assert.strictEqual(r3.text, '短智能');
  ok('术语统一：最长优先、等长输入顺序优先、左起点优先');
}

// 56. 基于原文一次匹配：替换结果不再参与匹配；相邻命中互不重叠
{
  // 替换为「bb」后不会再被 b->X 规则匹配（否则会出现 X X）
  const r = applyTerminology('aaa', [
    { from: 'a', to: 'b' },
  ]);
  assert.strictEqual(r.text, 'bbb');

  // 链式替换若迭代会无限/多次：aa -> b 只做一轮
  const r2 = applyTerminology('aaaa', [{ from: 'aa', to: 'a' }]);
  assert.strictEqual(r2.text, 'aa');
  assert.strictEqual(r2.hits, 2);
  ok('术语统一：基于原文一次匹配，替换结果不再参与匹配');
}

// 57. 空替换词（删除原词）：命中外的标签保留，命中内标签贴在末尾缝隙
{
  const r = applyTerminology('a人工智能b', [{ from: '人工智能', to: '' }]);
  assert.strictEqual(r.text, 'ab');

  const r2 = applyTerminology('人<b>工</b>智能', [{ from: '人工智能', to: '' }]);
  assert.strictEqual(r2.text, '<b></b>');
  ok('术语统一：空替换词删除可见文字但保留标签');
}

// 58. 字素边界匹配（emoji / 组合字符不被拆开）
{
  const r = applyTerminology('👨‍👩‍👧 家庭', [{ from: '👨‍👩‍👧', to: '家' }]);
  assert.strictEqual(r.text, '家 家庭');
  assert.strictEqual(r.hits, 1);
  ok('术语统一：按字素簇匹配');
}

// 59. 批量规划：只处理未锁定片段；分类、统计与输入不变
{
  const cs: Cue[] = [
    tcue('a', '人工智能'),
    tcue('b', '无命中'),
    tcue('c', '人工智能人工智能'),
    tcue('L', '人工智能', true),
  ];
  const snapshot = JSON.parse(JSON.stringify(cs));
  const plan = planTerminology(cs, [{ from: '人工智能', to: 'AI' }]);
  assert.deepStrictEqual(plan.changes.map((x) => x.id), ['a', 'c']);
  assert.strictEqual(plan.changes[0].replaced, 'AI');
  assert.strictEqual(plan.changes[1].replaced, 'AIAI');
  assert.strictEqual(plan.changes[1].hits, 2);
  assert.strictEqual(plan.unlockedUnchanged, 1);
  assert.strictEqual(plan.lockedSkipped, 1);
  assert.strictEqual(plan.totalHits, 3);
  assert.deepStrictEqual(cs, snapshot);
  ok('术语统一：批量仅处理未锁定片段，统计正确，输入不变');
}

// 60. 空原词忽略、重复原词只取最先输入；无规则时原样
{
  const plan = planTerminology(
    [tcue('a', '人工智能')],
    [
      { from: '', to: 'X' },
      { from: '人工智能', to: '一' },
      { from: '人工智能', to: '二' },
    ],
  );
  assert.strictEqual(plan.rules.length, 1);
  assert.strictEqual(plan.rules[0].inputIndex, 1);
  assert.strictEqual(plan.changes[0].replaced, '一');

  const r = applyTerminology('人工智能', []);
  assert.strictEqual(r.text, '人工智能');
  assert.strictEqual(r.hits, 0);
  ok('术语统一：空原词忽略、重复原词取最先、无规则原样');
}

// 61. 大小写敏感；多时间戳标签分段、跨段命中不合并、全部标签原样
{
  const r = applyTerminology('ABC abc', [{ from: 'abc', to: 'X' }]);
  assert.strictEqual(r.text, 'ABC X');
  assert.strictEqual(r.hits, 1);

  const text = '人工<00:01.000>智能<00:02.000>人工智能';
  const r2 = applyTerminology(text, [{ from: '人工智能', to: 'AI' }]);
  // 跨第一个时间戳的「人工…智能」不命中；末段「人工智能」命中
  assert.strictEqual(r2.text, '人工<00:01.000>智能<00:02.000>AI');
  assert.strictEqual(r2.hits, 1);

  // 每段独立计数；同段内相邻命中
  const r3 = applyTerminology('人工智能<00:01.000>人工智能', [{ from: '人工智能', to: 'AI' }]);
  assert.strictEqual(r3.text, 'AI<00:01.000>AI');
  assert.strictEqual(r3.hits, 2);

  // 不完整的尖括号按普通字符参与匹配
  const r4 = applyTerminology('人工<b智能', [{ from: '人工<b智能', to: 'X' }]);
  assert.strictEqual(r4.text, 'X');
  assert.strictEqual(r4.hits, 1);
  ok('术语统一：大小写敏感、时间戳分段独立计数、不完整尖括号按字符处理');
}

// 62. 确认写入 + 导出往返：只改正文，时间码/标识符/设置/锁定/文件头保留
{
  const v = `WEBVTT

NOTE 保留头

cid-61
00:01.000 --> 00:04.000 line:90% align:middle
人工<b>智能</b>真好用
`;
  const p = parseVTT(v);
  assert.ok(!p.error, p.error);
  const plan = planTerminology(p.cues, [{ from: '人工智能', to: 'AI' }]);
  assert.strictEqual(plan.changes.length, 1);
  const applied = p.cues.map((c) =>
    c.id === plan.changes[0].id ? { ...c, text: plan.changes[0].replaced } : c,
  );
  assert.strictEqual(applied[0].start, 1);
  assert.strictEqual(applied[0].end, 4);
  assert.strictEqual(applied[0].identifier, 'cid-61');
  assert.strictEqual(applied[0].settings, 'line:90% align:middle');
  const out = serializeVTT(applied, p.preamble);
  assert.ok(out.includes('NOTE 保留头'));
  // 命中跨 <b>：开标签在缝隙 3（超出替换词长度 2）贴替换词末尾，闭标签随之
  assert.ok(out.includes('AI<b></b>真好用'), out);
  assert.ok(out.includes('00:01.000 --> 00:04.000 line:90% align:middle'));
  const re = parseVTT(out);
  assert.ok(!re.error, re.error);
  assert.strictEqual(re.cues[0].text, 'AI<b></b>真好用');
  ok('术语统一：应用后导出保留标识符/设置/时间码/文件头，正文写入且可往返');
}

// ---------- 说话人标注迁移 ----------

function spk(id: string, s: number, e: number, text: string, locked = false): Cue {
  return { id, identifier: '', start: s, end: e, text, settings: '', locked };
}

// 63. 区间表解析：制表符/逗号/空白分隔、时间码与纯秒数、角色名去重保序、坏行记录
{
  const t = parseSpeakerTable(
    '00:00.500\t00:02.000\t张三\n00:02.000,00:04.000,李四\n00:04.500 00:06.000 Mary Jane\n7 8 张三\n00:08,500 00:09,000 王五',
  );
  assert.strictEqual(t.errors.length, 0, JSON.stringify(t.errors));
  assert.strictEqual(t.intervals.length, 5);
  assert.deepStrictEqual(t.roles, ['张三', '李四', 'Mary Jane', '王五']);
  assert.strictEqual(t.intervals[0].start, 0.5);
  assert.strictEqual(t.intervals[3].start, 7); // 纯秒数
  assert.strictEqual(t.intervals[4].start, 8.5); // 逗号小数时间码 + 空白分隔
  assert.strictEqual(t.intervals[2].name, 'Mary Jane'); // 角色名含空格

  const bad = parseSpeakerTable('仅两列 张三\n00:75.000 00:02.000 张三\n00:03.000 00:01.000 张三\n00:01.000 00:02.000\n\n');
  assert.strictEqual(bad.intervals.length, 0);
  assert.strictEqual(bad.errors.length, 4);
  assert.ok(bad.errors[0].reason.includes('三列'));
  assert.ok(bad.errors[1].reason.includes('时间'));
  assert.ok(bad.errors[2].reason.includes('晚于起点'));
  ok('说话人：区间表解析（分隔符/秒数/逗号小数，坏行记录）');
}

// 64. <v> 标签统计与角色注解提取
{
  assert.deepStrictEqual(voiceInfo('你好'), { count: 0, name: null });
  assert.deepStrictEqual(voiceInfo('<v Bob>你好</v>'), { count: 1, name: 'Bob' });
  assert.deepStrictEqual(voiceInfo('<v.first.loud 张三>你好</v>'), { count: 1, name: '张三' });
  assert.deepStrictEqual(voiceInfo('<v>你好</v>'), { count: 1, name: '' });
  assert.deepStrictEqual(voiceInfo('<v A>你</v>好<v B>吗</v>'), { count: 2, name: null });
  assert.deepStrictEqual(voiceInfo('<b>你好</b><00:01.000>世界'), { count: 0, name: null });
  ok('说话人：<v> 标签统计与角色注解提取');
}

// 65. 包入/更新最外层 <v> 标签：保留内联标签/时间戳/换行；多说话人不覆盖；角色名清洗
{
  const w = applyVoiceTag('<b>你好</b>\n<00:01.000>世界', '张三');
  assert.strictEqual(w, '<v 张三><b>你好</b>\n<00:01.000>世界</v>');

  const u = applyVoiceTag('前<v.first Bob>你好</v>后', 'Alice');
  assert.strictEqual(u, '前<v.first Alice>你好</v>后');
  const u2 = applyVoiceTag('<v Bob>你好</v>', 'Alice');
  assert.strictEqual(u2, '<v Alice>你好</v>');

  assert.strictEqual(applyVoiceTag('<v A>你</v><v B>好</v>', 'C'), null);
  assert.strictEqual(applyVoiceTag('你好', 'a<b>&c'), '<v abc>你好</v>');
  assert.strictEqual(applyVoiceTag('你好', '<>'), null);
  ok('说话人：包入/更新 <v> 标签，多说话人不覆盖，角色名清洗');
}

// 66. 重叠时长汇总取最长；无重叠跳过；锁定跳过；输入不被修改
{
  const table = parseSpeakerTable(
    ['00:00.000 00:02.000 甲', '00:04.000 00:06.000 甲', '00:01.000 00:05.000 乙', '00:10.000 00:12.000 乙'].join('\n'),
  );
  const cs: Cue[] = [
    spk('a', 0, 2, 'A'),   // 甲 2s vs 乙 1s → 甲
    spk('b', 3, 5, 'B'),   // 甲 1s vs 乙 2s → 乙
    spk('c', 1, 3, 'C'),   // 甲 1s vs 乙 2s → 乙
    spk('d', 20, 22, 'D'), // 无重叠
    spk('L', 0, 2, 'L', true),
  ];
  const snapshot = JSON.parse(JSON.stringify(cs));
  const plan = planSpeakers(cs, table);
  const byId = new Map(plan.rows.map((r) => [r.id, r]));
  assert.strictEqual(byId.get('a')!.status, 'apply');
  assert.strictEqual(byId.get('a')!.candidate, '甲');
  assert.strictEqual(byId.get('a')!.newText, '<v 甲>A</v>');
  assert.strictEqual(byId.get('b')!.candidate, '乙');
  assert.strictEqual(byId.get('c')!.candidate, '乙');
  assert.strictEqual(byId.get('d')!.status, 'skip');
  assert.ok(byId.get('d')!.reason!.includes('重叠'));
  assert.strictEqual(plan.lockedSkipped, 1);
  assert.strictEqual(plan.changes.length, 3);
  assert.deepStrictEqual(cs, snapshot);
  ok('说话人：重叠汇总取最长，无重叠/锁定跳过，输入不变');
}

// 67. 同分列为歧义等待手工选择；手工改选与逐条排除生效
{
  const table = parseSpeakerTable('00:00.000 00:02.000 甲\n00:00.000 00:02.000 乙\n00:00.000 00:02.000 丙\n00:00.000 00:01.000 丁');
  const cs: Cue[] = [spk('a', 0, 2, 'A')];
  const plan = planSpeakers(cs, table);
  assert.strictEqual(plan.rows[0].status, 'ambiguous');
  assert.deepStrictEqual(plan.rows[0].tied, ['甲', '乙', '丙']);
  assert.strictEqual(plan.rows[0].candidate, null);
  assert.strictEqual(plan.changes.length, 0);

  // 手工选择后进入写入
  const plan2 = planSpeakers(cs, table, new Set(), new Map([['a', '乙']]));
  assert.strictEqual(plan2.rows[0].status, 'apply');
  assert.strictEqual(plan2.rows[0].candidate, '乙');
  assert.strictEqual(plan2.rows[0].manual, true);
  assert.strictEqual(plan2.changes.length, 1);
  assert.strictEqual(plan2.changes[0].text, '<v 乙>A</v>');

  // 逐条排除后不写入
  const plan3 = planSpeakers(cs, table, new Set(['a']), new Map([['a', '乙']]));
  assert.strictEqual(plan3.rows[0].excluded, true);
  assert.strictEqual(plan3.changes.length, 0);

  // 手工选择的角色已不在表中时忽略，回到自动结果（歧义）
  const plan4 = planSpeakers(cs, table, new Set(), new Map([['a', '不存在']]));
  assert.strictEqual(plan4.rows[0].status, 'ambiguous');
  assert.strictEqual(plan4.rows[0].manual, false);
  ok('说话人：同分列为歧义，手工选择/逐条排除生效');
}

// 68. 多说话人片段不自动覆盖；已是该角色跳过；单标签更新保留 class 与位置
{
  const table = parseSpeakerTable('00:00.000 00:02.000 甲');
  const cs: Cue[] = [
    spk('m', 0, 2, '<v 甲>你</v>好<v 乙>吗</v>'),
    spk('s', 0, 2, '<v 甲>你好</v>'),
    spk('u', 0, 2, '<v.first 丙>你好</v>尾'),
  ];
  const plan = planSpeakers(cs, table);
  const byId = new Map(plan.rows.map((r) => [r.id, r]));
  assert.strictEqual(byId.get('m')!.status, 'skip');
  assert.ok(byId.get('m')!.reason!.includes('多个说话人'));
  assert.strictEqual(byId.get('s')!.status, 'skip');
  assert.ok(byId.get('s')!.reason!.includes('无需修改'));
  const u = byId.get('u')!;
  assert.strictEqual(u.status, 'apply');
  assert.strictEqual(u.original, '丙');
  assert.strictEqual(u.newText, '<v.first 甲>你好</v>尾');
  assert.deepStrictEqual(plan.changes.map((c) => c.id), ['u']);
  ok('说话人：多说话人不覆盖、同名跳过、单标签更新保留 class');
}

// 69. 端到端：写入后导出保留内联标签/时间戳/换行/标识符/设置/文件头，可往返
{
  const v = `WEBVTT

NOTE 保留头

cid-sp
00:01.000 --> 00:03.000 line:90%
<b>你好</b>
<00:02.000>世界
`;
  const p = parseVTT(v);
  assert.ok(!p.error, p.error);
  const table = parseSpeakerTable('00:00.000 00:04.000 张三');
  const plan = planSpeakers(p.cues, table);
  assert.strictEqual(plan.changes.length, 1);
  const applied = p.cues.map((c) =>
    c.id === plan.changes[0].id ? { ...c, text: plan.changes[0].text } : c,
  );
  const out = serializeVTT(applied, p.preamble);
  assert.ok(out.includes('NOTE 保留头'));
  assert.ok(out.includes('cid-sp'));
  assert.ok(out.includes('00:01.000 --> 00:03.000 line:90%'));
  assert.ok(out.includes('<v 张三><b>你好</b>\n<00:02.000>世界</v>'));
  const re = parseVTT(out);
  assert.ok(!re.error, re.error);
  assert.strictEqual(re.cues[0].text, '<v 张三><b>你好</b>\n<00:02.000>世界</v>');
  assert.strictEqual(re.cues[0].identifier, 'cid-sp');
  assert.strictEqual(re.cues[0].settings, 'line:90%');
  ok('说话人：写入后导出保留标签/时间戳/换行/标识符/设置并可往返');
}

console.log(`\n全部 ${passed} 组测试通过 ✅`);