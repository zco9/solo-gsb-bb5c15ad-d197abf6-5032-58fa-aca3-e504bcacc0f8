import { useMemo, useState } from 'react';
import type { Cue } from '../lib/types';
import { planTerminology, type TermRule } from '../lib/term';
import { formatTimecode } from '../lib/time';

interface Props {
  /** 当前字幕（已按 start 排序）；仅未锁定片段参与替换，规划本身不改数据 */
  cues: Cue[];
  /** 确认写入：仅把命中片段的文本替换为新正文，其余字段由调用方保留 */
  onApply: (entries: { id: string; text: string }[], hitCount: number) => void;
  onJump: (id: string) => void;
}

interface RuleRow {
  uid: number;
  from: string;
  to: string;
}

let rowSeq = 0;
function newRow(from = '', to = ''): RuleRow {
  rowSeq += 1;
  return { uid: rowSeq, from, to };
}

/**
 * 术语统一面板：
 * 输入多组原词 / 替换词，对未锁定 cue 的正文生成批量替换预览。匹配以可见
 * 文字为准（允许跨越 <b> 等内联格式标签；时间戳标签与换行是匹配边界）；
 * 同位置多条命中取最长原词、等长按输入顺序；基于原文一次匹配。预览逐条
 * 给出命中次数与替换后正文；确认后只写入命中的未锁定 cue。
 */
export default function TermPanel({ cues, onApply, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RuleRow[]>([newRow(), newRow()]);

  const unlockedCount = useMemo(() => cues.filter((c) => !c.locked).length, [cues]);
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);

  // 输入中的重复原词（仅提示，实际生效取最先输入的一条）
  const duplicateFroms = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const r of rows) {
      const f = r.from;
      if (!f) continue;
      if (seen.has(f)) dup.add(f);
      else seen.add(f);
    }
    return dup;
  }, [rows]);

  const inputRules: TermRule[] = useMemo(
    () => rows.filter((r) => r.from.length > 0).map((r) => ({ from: r.from, to: r.to })),
    [rows],
  );
  const plan = useMemo(() => planTerminology(cues, inputRules), [cues, inputRules]);
  const ruleByIndex = useMemo(
    () => new Map(plan.rules.map((r) => [r.inputIndex, r])),
    [plan.rules],
  );

  function updateRow(uid: number, patch: Partial<RuleRow>) {
    setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  }
  function removeRow(uid: number) {
    setRows((rs) => rs.filter((r) => r.uid !== uid));
  }

  function confirm() {
    if (plan.changes.length === 0) return;
    onApply(
      plan.changes.map((c) => ({ id: c.id, text: c.replaced })),
      plan.totalHits,
    );
    setOpen(false);
  }

  if (!open) {
    return (
      <section className="panel term-panel">
        <h2>
          术语统一
          <span className="muted small ml">未锁定片段批量替换</span>
        </h2>
        <p className="muted small">
          输入多组原词与替换词，按可见文字对未锁定片段批量替换（可跨越 <span className="mono">&lt;b&gt;</span> 等内联标签，
          时间戳标签为边界）；先预览命中次数与替换结果，确认后只写入命中片段。
        </p>
        <button className="btn primary" disabled={unlockedCount === 0} onClick={() => setOpen(true)}>
          设置替换规则并预览
        </button>
        {unlockedCount === 0 && (
          <p className="muted small">当前没有未锁定片段（锁定片段不参与术语统一）。</p>
        )}
      </section>
    );
  }

  return (
    <section className="panel term-panel">
      <h2>
        术语统一
        <span className="muted small ml">生效规则 {plan.rules.length} 条</span>
      </h2>
      <p className="muted small">
        按可见字素精确匹配（区分大小写）：允许原词跨越 <span className="mono">&lt;b&gt;</span>、
        <span className="mono">&lt;v …&gt;</span> 等内联格式标签；<span className="mono">&lt;00:01.500&gt;</span>
        时间戳标签与换行为匹配边界。同位置多条命中取<strong>最长原词</strong>，等长按<strong>输入顺序</strong>；
        基于原文一次匹配，替换结果不再参与匹配。所有标签原文、顺序与未命中文字均保留。
      </p>

      <div className="term-rules">
        <div className="term-rule-head small muted">
          <span className="term-rule-idx">#</span>
          <span>原词（匹配可见文字）</span>
          <span className="term-arrow">→</span>
          <span>替换词（留空 = 删除原词）</span>
          <span className="term-rule-del" />
        </div>
        {rows.map((r, i) => (
          <div
            key={r.uid}
            className={`term-rule-row${duplicateFroms.has(r.from) ? ' dup' : ''}`}
          >
            <span className="term-rule-idx mono">{i + 1}</span>
            <input
              className={`timecode-input term-input term-from${duplicateFroms.has(r.from) ? ' dup' : ''}`}
              type="text"
              value={r.from}
              placeholder="原词"
              onChange={(e) => updateRow(r.uid, { from: e.target.value })}
            />
            <span className="term-arrow">→</span>
            <input
              className="timecode-input term-input"
              type="text"
              value={r.to}
              placeholder="替换词"
              onChange={(e) => updateRow(r.uid, { to: e.target.value })}
            />
            <button
              className="mini term-rule-del"
              title="删除该规则"
              onClick={() => removeRow(r.uid)}
            >
              ✕
            </button>
            {duplicateFroms.has(r.from) && (
              <div className="term-rule-note">重复原词：仅最先输入的一条生效</div>
            )}
          </div>
        ))}
      </div>
      <div className="merge-actions">
        <button className="btn" onClick={() => setRows((rs) => [...rs, newRow()])}>
          + 增加规则
        </button>
        {rows.length > 1 && (
          <button className="btn" onClick={() => setRows((rs) => rs.slice(0, -1))}>
            删除末行
          </button>
        )}
      </div>

      {plan.rules.length > 0 && (
        <div className="merge-summary">
          命中片段 <strong>{plan.changes.length}</strong> 条 · 命中总次数{' '}
          <strong>{plan.totalHits}</strong> · 未命中（未锁定）{plan.unlockedUnchanged} 条 ·
          锁定跳过 {plan.lockedSkipped} 条
        </div>
      )}

      {plan.rules.length === 0 && (
        <div className="import-error">请至少输入一条非空原词规则。</div>
      )}

      {plan.rules.length > 0 && plan.changes.length === 0 && (
        <div className="import-error">当前未锁定片段中没有任何规则命中，确认按钮不可用。</div>
      )}

      {plan.changes.length > 0 && (
        <>
          <div className="merge-section-label">替换预览（{plan.changes.length} 条，仅显示命中的未锁定片段）</div>
          <ul className="merge-list term-list">
            {plan.changes.map((ch, i) => {
              const cue = cueById.get(ch.id);
              return (
                <li
                  key={ch.id}
                  className="merge-row wrap-row changed"
                  onClick={() => onJump(ch.id)}
                  title="点击定位到该片段"
                >
                  <div className="merge-head mono">
                    <span className="merge-idx">#{i + 1}</span>
                    {cue && (
                      <span>
                        {formatTimecode(cue.start)} – {formatTimecode(cue.end)}
                      </span>
                    )}
                    <span className="term-hit-badge">命中 {ch.hits} 次</span>
                    <span className="term-rule-hits small">
                      {ch.ruleHits
                        .map((rh) => {
                          const rr = ruleByIndex.get(rh.ruleIndex);
                          return rr ? `#${rh.ruleIndex + 1} 「${rr.from}」×${rh.count}` : '';
                        })
                        .join('　')}
                    </span>
                  </div>
                  <div className="wrap-text orig">
                    <span className="wrap-label">原文</span>
                    {ch.original}
                  </div>
                  <div className="wrap-text suggested">
                    <span className="wrap-label">替换</span>
                    {ch.replaced}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="merge-actions end">
        <button className="btn" onClick={() => setOpen(false)}>取消</button>
        <button className="btn primary" disabled={plan.changes.length === 0} onClick={confirm}>
          确认写入（{plan.changes.length} 条 · {plan.totalHits} 处）
        </button>
      </div>
    </section>
  );
}
