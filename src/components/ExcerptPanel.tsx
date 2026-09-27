import { useMemo, useState } from 'react';
import type { Cue } from '../lib/types';
import { planExcerpt } from '../lib/excerpt';
import { formatTimecode } from '../lib/time';
import TimeCodeInput from './TimeCodeInput';

interface Props {
  /** 当前字幕（已按 start 排序）；仅用于预览/下载，不会被改动 */
  cues: Cue[];
  /** 按摘录计划下载独立 WebVTT */
  onDownload: (planCues: { id: string; start: number; end: number; text: string }[]) => void;
  onJump: (id: string) => void;
}

/**
 * 片段摘录导出面板：
 * 输入原时间轴上的起止时间，实时预览命中的 cue 数量与裁剪后的时间码，
 * 再下载一份独立 WebVTT（时间统一减去摘录起点）。仅左闭右开正时长交集
 * 的 cue 纳入；无命中或时间范围无效时说明原因并禁止下载。当前编辑内容不变。
 */
export default function ExcerptPanel({ cues, onDownload, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);

  const span = useMemo(
    () => cues.reduce((m, c) => Math.max(m, c.end), 0),
    [cues],
  );

  function openPanel() {
    // 打开时给出一个覆盖整个时间轴的默认区间，便于直接预览
    setFrom(0);
    setTo(span);
    setOpen(true);
  }

  const plan = useMemo(() => planExcerpt(cues, from, to), [cues, from, to]);

  function firstLine(text: string): string {
    return text.split('\n')[0]?.replace(/<[^>]+>/g, '') ?? '';
  }

  function download() {
    if (plan.error || plan.cues.length === 0) return;
    onDownload(
      plan.cues.map((c) => ({ id: c.id, start: c.start, end: c.end, text: c.text })),
    );
  }

  if (!open) {
    return (
      <section className="panel excerpt-panel">
        <h2>
          片段摘录导出
          <span className="muted small ml">按区间导出独立 VTT</span>
        </h2>
        <p className="muted small">
          输入原时间轴上的起止时间，预览命中的片段与裁剪后的时间码，再下载一份独立 WebVTT（时间码归零重排）。当前编辑内容不会被改动。
        </p>
        <button className="btn primary" disabled={cues.length === 0} onClick={openPanel}>
          设置摘录区间并预览
        </button>
      </section>
    );
  }

  return (
    <section className="panel excerpt-panel">
      <h2>
        片段摘录导出
        <span className="muted small ml">
          区间 {formatTimecode(from)} – {formatTimecode(to)}
        </span>
      </h2>
      <p className="muted small">
        仅纳入与左闭右开区间有<strong>正时长交集</strong>的片段（仅端点相接不纳入）；
        起止裁到交集后统一减去摘录起点，时间码从 00:00.000 重新开始。下载不影响当前编辑内容。
      </p>

      <div className="row time-row">
        <span className="excerpt-label">摘录起点</span>
        <TimeCodeInput value={from} onCommit={setFrom} />
      </div>
      <div className="row time-row">
        <span className="excerpt-label">摘录终点</span>
        <TimeCodeInput value={to} onCommit={setTo} />
        <button
          className="mini"
          title={`取当前时间轴末尾 ${formatTimecode(span)}`}
          onClick={() => setTo(span)}
        >
          到时间轴末尾
        </button>
      </div>
      <div className="row muted small mono">
        区间长度 {plan.error ? '—' : formatTimecode(to - from)}
      </div>

      {plan.error && <div className="import-error">{plan.error}</div>}

      {!plan.error && plan.cues.length === 0 && (
        <div className="import-error">
          该区间内没有与 <span className="mono">[{formatTimecode(from)}, {formatTimecode(to)})</span> 有正时长交集的片段（仅端点相接不计），无法下载。
        </div>
      )}

      {!plan.error && plan.cues.length > 0 && (
        <>
          <div className="merge-summary">
            ✅ 命中 <strong>{plan.cues.length}</strong> 个片段 · 时间码统一减去{' '}
            {formatTimecode(plan.from)}
          </div>
          <div className="merge-section-label">裁剪预览（{plan.cues.length} 条）</div>
          <ul className="merge-list excerpt-list">
            {plan.cues.map((c, i) => {
              const src = cues.find((x) => x.id === c.id);
              const clippedLeft = c.origStart < plan.from;
              const clippedRight = c.origEnd > plan.to;
              return (
                <li
                  key={`${c.id}-${i}`}
                  className="merge-row paired"
                  onClick={() => onJump(c.id)}
                  title="点击定位到原时间轴上的片段"
                >
                  <div className="merge-head mono">
                    <span className="merge-idx">#{i + 1}</span>
                    <span>
                      {formatTimecode(c.start)} – {formatTimecode(c.end)}
                    </span>
                    {(clippedLeft || clippedRight) && (
                      <span className="excerpt-clip-tag">
                        裁剪{clippedLeft ? '左' : ''}
                        {clippedRight ? '右' : ''}
                      </span>
                    )}
                    {src?.locked && <span className="merge-lock">🔒</span>}
                  </div>
                  <div className="muted small mono excerpt-orig">
                    原 {formatTimecode(c.origStart)} – {formatTimecode(c.origEnd)}
                  </div>
                  <div className="merge-text main excerpt-body">{c.text}</div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="merge-actions end">
        <button className="btn" onClick={() => setOpen(false)}>关闭</button>
        <button
          className="btn primary"
          disabled={!!plan.error || plan.cues.length === 0}
          onClick={download}
        >
          下载摘录 WebVTT{!plan.error && plan.cues.length > 0 ? `（${plan.cues.length} 条）` : ''}
        </button>
      </div>
    </section>
  );
}
