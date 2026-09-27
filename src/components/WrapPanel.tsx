import { useMemo, useState } from 'react';
import type { Cue } from '../lib/types';
import { planSmartWrap } from '../lib/wrap';
import { formatTimecode } from '../lib/time';

interface Props {
  /** 当前字幕（已按 start 排序）；仅未锁定片段参与规划，规划本身不改数据 */
  cues: Cue[];
  /** 确认应用：仅把可行片段的文本替换为建议文本（增删换行），其余字段由调用方保留 */
  onApply: (entries: { id: string; text: string }[]) => void;
  onJump: (id: string) => void;
}

/**
 * 智能分行面板：
 * 对当前未锁定字幕批量生成不超过两行的换行建议。行宽按可见字素计算
 * （中文及全角字符计 2，其余计 1；内联标签与时间戳标签不计宽且不可拆开）。
 * 预览原文、建议文本与无解项；确认后仅增删可行片段的换行，其余字符、
 * 标签、时间戳、时间码与 cue 设置原样保留。
 */
export default function WrapPanel({ cues, onApply, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [maxWidth, setMaxWidth] = useState(20);

  const unlockedCount = useMemo(() => cues.filter((c) => !c.locked).length, [cues]);
  const width = Number.isFinite(maxWidth) && maxWidth >= 1 ? Math.floor(maxWidth) : 1;
  const plan = useMemo(() => planSmartWrap(cues, width), [cues, width]);
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);

  function confirm() {
    if (plan.changes.length === 0) return;
    onApply(plan.changes.map((c) => ({ id: c.id, text: c.suggested })));
    setOpen(false);
  }

  if (!open) {
    return (
      <section className="panel wrap-panel">
        <h2>
          智能分行
          <span className="muted small ml">未锁定片段 ≤ 两行</span>
        </h2>
        <p className="muted small">
          按可见字素宽度（中文/全角计 2，其余计 1，标签不计）为当前未锁定字幕批量生成
          不超过两行的换行建议；确认后仅增删可行片段的换行，其余内容原样保留。
        </p>
        <button className="btn primary" disabled={unlockedCount === 0} onClick={() => setOpen(true)}>
          生成换行建议
        </button>
        {unlockedCount === 0 && (
          <p className="muted small">当前没有未锁定片段（锁定片段不参与分行）。</p>
        )}
      </section>
    );
  }

  return (
    <section className="panel wrap-panel">
      <h2>
        智能分行
        <span className="muted small ml">每行 ≤ {width}</span>
      </h2>
      <p className="muted small">
        断点选在空格、标点或字素边界，优先让两行宽差最小；闭合标点不会出现在行首，
        开放标点不会出现在行尾；标签与时间戳标签不计宽、不拆开。
      </p>

      <div className="row wrap-width-row">
        <span className="excerpt-label">每行最大宽度</span>
        <input
          type="number"
          className="timecode-input wrap-width-input"
          min={1}
          max={400}
          step={1}
          value={maxWidth}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            setMaxWidth(Number.isFinite(v) ? v : 1);
          }}
        />
        <span className="muted small">中文/全角计 2，其余计 1</span>
      </div>

      <div className="merge-summary">
        建议调整 <strong>{plan.changes.length}</strong> 条 · 无需调整 {plan.kept.length} 条 ·
        无解 {plan.failures.length} 条 · 锁定跳过 {plan.lockedSkipped} 条
      </div>

      {plan.changes.length > 0 && (
        <>
          <div className="merge-section-label">换行建议（{plan.changes.length} 条）</div>
          <ul className="merge-list wrap-list">
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
                    <span className="wrap-widths">
                      {ch.lineWidths[1] > 0
                        ? `${ch.lineWidths[0]} + ${ch.lineWidths[1]}`
                        : `${ch.lineWidths[0]}`}{' '}
                      ≤ {width}
                    </span>
                  </div>
                  <div className="wrap-text orig">
                    <span className="wrap-label">原文</span>
                    {ch.original}
                  </div>
                  <div className="wrap-text suggested">
                    <span className="wrap-label">建议</span>
                    {ch.suggested}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {plan.failures.length > 0 && (
        <>
          <div className="merge-section-label">
            无解（{plan.failures.length} 条，保持原文）
          </div>
          <ul className="merge-list wrap-fail-list">
            {plan.failures.map((f, i) => {
              const cue = cueById.get(f.id);
              return (
                <li
                  key={f.id}
                  className="merge-row wrap-row failed"
                  onClick={() => onJump(f.id)}
                  title="点击定位到该片段"
                >
                  <div className="merge-head mono">
                    <span className="merge-idx">#{i + 1}</span>
                    {cue && (
                      <span>
                        {formatTimecode(cue.start)} – {formatTimecode(cue.end)}
                      </span>
                    )}
                  </div>
                  <div className="wrap-text orig">
                    <span className="wrap-label">原文</span>
                    {f.original}
                  </div>
                  <div className="wrap-reason">⛔ {f.reason}</div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="merge-actions end">
        <button className="btn" onClick={() => setOpen(false)}>取消</button>
        <button className="btn primary" disabled={plan.changes.length === 0} onClick={confirm}>
          确认应用（{plan.changes.length} 条）
        </button>
      </div>
    </section>
  );
}
