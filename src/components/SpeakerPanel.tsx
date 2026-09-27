import { useMemo, useState } from 'react';
import type { Cue } from '../lib/types';
import {
  applyVoiceTag,
  parseSpeakerTable,
  planSpeakerMigration,
  type SpeakerEntry,
} from '../lib/speaker';
import { formatTimecode } from '../lib/time';

interface Props {
  /** 当前字幕（已按 start 排序）；仅未锁定片段参与迁移，规划本身不改数据 */
  cues: Cue[];
  /** 确认应用：仅把可应用片段的文本替换为包好 <v> 标签的新正文，其余字段由调用方保留 */
  onApply: (entries: { id: string; text: string; name: string }[], applied: number) => void;
  onJump: (id: string) => void;
}

const PLACEHOLDER = `起点\t终点\t角色名
00:00.000\t00:04.500\t张三
00:04.500\t00:09.000\t李四
00:09.000\t00:12.000\t王五`;

/** 手工决定：明确选择某角色，或排除（跳过）该条 */
type Override = { kind: 'name'; name: string } | { kind: 'exclude' };

/**
 * 说话人标注迁移面板：
 * 粘贴“起点、终点、角色名”表，按时间区间与未锁定字幕的重叠时长汇总各角色，
 * 选重叠最长的角色；无重叠跳过，同分列为歧义等待手工选择。预览显示原角色、
 * 候选角色与跳过原因，可逐条排除或改选；确认后只把单一说话人的字幕正文
 * 包入或更新最外层 WebVTT <v 角色名> 标签。
 */
export default function SpeakerPanel({ cues, onApply, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());

  const unlockedCount = useMemo(() => cues.filter((c) => !c.locked).length, [cues]);
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);

  const table = useMemo(() => parseSpeakerTable(raw), [raw]);
  const plan = useMemo(() => planSpeakerMigration(cues, table.segs), [cues, table.segs]);

  /**
   * 合并自动规划与手工决定后的逐条状态。输入或字幕变化时随 plan 重算：
   * - 手工改选的角色仍在候选中 => 保留；候选已消失则自动决策失效；
   * - 手工排除始终保留（该条已被用户明确剔除），可在跳过区恢复。
   */
  const resolved = useMemo(() => {
    return plan.entries.map((e) => {
      const ov = overrides.get(e.id);
      let state: 'unique' | 'ambiguous' | 'none' | 'locked' | 'multi' | 'excluded';
      let name: string | null = null;
      let reason: string | null = e.reason;

      if (ov?.kind === 'exclude' && !e.locked && e.status !== 'multi') {
        state = 'excluded';
        reason = '已手工排除（不写入）';
      } else if (ov?.kind === 'name' && e.candidates.some((c) => c.name === ov.name)) {
        state = 'unique';
        name = ov.name;
        reason = null;
      } else if (e.status === 'unique') {
        state = 'unique';
        name = e.chosen;
      } else {
        state = e.status;
      }
      return { entry: e, state, name, reason };
    });
  }, [plan, overrides]);

  /** 确认后可写入的条目：单一角色，且正文包装后确实发生变化（已为该角色则跳过） */
  const applicable = useMemo(() => {
    const out: { id: string; text: string; name: string; preview: string }[] = [];
    for (const r of resolved) {
      if (r.state !== 'unique' || !r.name) continue;
      const preview = applyVoiceTag(r.entry.original, r.name);
      if (preview !== null && preview !== r.entry.original) {
        out.push({ id: r.entry.id, text: preview, name: r.name, preview });
      }
    }
    return out;
  }, [resolved]);

  const uniqueRows = resolved.filter((r) => r.state === 'unique');
  const ambiguousRows = resolved.filter((r) => r.state === 'ambiguous');
  const skippedRows = resolved.filter(
    (r) => r.state === 'none' || r.state === 'locked' || r.state === 'multi' || r.state === 'excluded',
  );

  function setOverride(id: string, ov: Override | null) {
    setOverrides((prev) => {
      const next = new Map(prev);
      if (ov === null) next.delete(id);
      else next.set(id, ov);
      return next;
    });
  }

  function confirm() {
    if (applicable.length === 0) return;
    onApply(
      applicable.map((a) => ({ id: a.id, text: a.text, name: a.name })),
      applicable.length,
    );
    setOverrides(new Map());
    setOpen(false);
  }

  function cancelAll() {
    setOverrides(new Map());
    setOpen(false);
  }

  if (!open) {
    return (
      <section className="panel speaker-panel">
        <h2>
          说话人标注迁移
          <span className="muted small ml">未锁定片段按重叠选角色</span>
        </h2>
        <p className="muted small">
          粘贴「起点、终点、角色名」表，按时间区间重叠最长者为未锁定片段选择说话人，同分列为歧义手工选择；
          确认后只把单一说话人的正文包入或更新最外层 <span className="mono">&lt;v 角色名&gt;</span> 标签。
        </p>
        <button className="btn primary" disabled={unlockedCount === 0} onClick={() => setOpen(true)}>
          粘贴角色区间表并预览
        </button>
        {unlockedCount === 0 && (
          <p className="muted small">当前没有未锁定片段（锁定片段不参与说话人迁移）。</p>
        )}
      </section>
    );
  }

  return (
    <section className="panel speaker-panel">
      <h2>
        说话人标注迁移
        <span className="muted small ml">
          区间 {table.segs.length} 条{table.segs.length > 0 ? ` · 角色 ${new Set(table.segs.map((s) => s.name)).size} 个` : ''}
        </span>
      </h2>
      <p className="muted small">
        每行 <span className="mono">起点&nbsp;终点&nbsp;角色名</span>（从表格粘贴按 Tab 分列，也可用逗号或空格分隔，首行可为表头）。
        按时间区间与未锁定片段的<strong>重叠总时长</strong>汇总各角色，取最长者；最长并列列为歧义等待手工选择；
        无重叠跳过；正文已含多个 <span className="mono">&lt;v&gt;</span> 说话人片段时不自动覆盖。
      </p>

      <textarea
        className="paste-area mono merge-paste"
        rows={7}
        placeholder={PLACEHOLDER}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      {table.badLines > 0 && (
        <div className="import-error">有 {table.badLines} 行无法解析（时间码无效、终点不晚于起点或角色名为空），已忽略。</div>
      )}
      {raw.trim() && table.segs.length === 0 && (
        <div className="import-error">未能从表中解析出任何有效的「起点、终点、角色名」行。</div>
      )}

      <div className="merge-summary">
        将写入 <strong>{applicable.length}</strong> 条 · 唯一候选 {uniqueRows.length} 条 ·
        歧义待选 <strong>{ambiguousRows.length}</strong> 条 · 跳过 {skippedRows.length} 条
      </div>

      {uniqueRows.length > 0 && (
        <>
          <div className="merge-section-label">单一角色（{uniqueRows.length} 条，可改选或排除）</div>
          <ul className="merge-list speaker-list">
            {uniqueRows.map((r, i) => {
              const e = r.entry;
              const cue = cueById.get(e.id);
              const preview = r.name ? applyVoiceTag(e.original, r.name) : null;
              return (
                <li key={e.id} className="merge-row wrap-row changed speaker-row">
                  <div className="merge-head mono" onClick={() => onJump(e.id)} title="点击定位到该片段">
                    <span className="merge-idx">#{i + 1}</span>
                    {cue && (
                      <span>
                        {formatTimecode(e.start)} – {formatTimecode(e.end)}
                      </span>
                    )}
                    <span className="speaker-badge ok">→ {r.name}</span>
                    {e.voiceNames.length > 0 && (
                      <span className="speaker-orig-name small">原角色：{e.voiceNames.join('、') || '（未命名 <v>）'}</span>
                    )}
                  </div>
                  <div className="wrap-text orig">
                    <span className="wrap-label">原文</span>
                    {e.original}
                  </div>
                  {preview !== null && preview !== e.original && (
                    <div className="wrap-text suggested">
                      <span className="wrap-label">写入</span>
                      {preview}
                    </div>
                  )}
                  {preview === e.original && (
                    <div className="speaker-same small muted">已是该角色标签，确认时不重复写入。</div>
                  )}
                  <div className="speaker-controls" onClick={(ev) => ev.stopPropagation()}>
                    <select
                      className="layout-select speaker-select"
                      value={r.name ?? ''}
                      onChange={(ev) => {
                        const v = ev.target.value;
                        if (v) setOverride(e.id, { kind: 'name', name: v });
                      }}
                    >
                      {e.candidates.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}（重叠 {(c.overlapMs / 1000).toFixed(2)}s）
                        </option>
                      ))}
                    </select>
                    <button className="mini" onClick={() => setOverride(e.id, { kind: 'exclude' })}>
                      排除本条
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {ambiguousRows.length > 0 && (
        <>
          <div className="merge-section-label">
            歧义待手工选择（{ambiguousRows.length} 条，不选择则不会写入）
          </div>
          <ul className="merge-list speaker-list">
            {ambiguousRows.map((r, i) => {
              const e = r.entry;
              const cue = cueById.get(e.id);
              const ov = overrides.get(e.id);
              const manualName = ov?.kind === 'name' ? ov.name : '';
              return (
                <li key={e.id} className="merge-row wrap-row failed speaker-row ambiguous">
                  <div className="merge-head mono" onClick={() => onJump(e.id)} title="点击定位到该片段">
                    <span className="merge-idx">#{i + 1}</span>
                    {cue && (
                      <span>
                        {formatTimecode(e.start)} – {formatTimecode(e.end)}
                      </span>
                    )}
                    <span className="speaker-badge warn">并列歧义</span>
                  </div>
                  <div className="wrap-text orig">
                    <span className="wrap-label">原文</span>
                    {e.original}
                  </div>
                  <div className="wrap-reason">⛔ {r.reason}</div>
                  <div className="speaker-controls" onClick={(ev) => ev.stopPropagation()}>
                    <select
                      className="layout-select speaker-select"
                      value={manualName}
                      onChange={(ev) => {
                        const v = ev.target.value;
                        setOverride(e.id, v ? { kind: 'name', name: v } : { kind: 'exclude' });
                      }}
                    >
                      <option value="">请选择角色…</option>
                      {e.candidates.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}（重叠 {(c.overlapMs / 1000).toFixed(2)}s）
                        </option>
                      ))}
                    </select>
                    <button className="mini" onClick={() => setOverride(e.id, { kind: 'exclude' })}>
                      排除本条
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {skippedRows.length > 0 && (
        <>
          <div className="merge-section-label">跳过（{skippedRows.length} 条）</div>
          <ul className="merge-list speaker-list">
            {skippedRows.map((r, i) => {
              const e: SpeakerEntry = r.entry;
              const cue = cueById.get(e.id);
              const isExcluded = r.state === 'excluded';
              return (
                <li
                  key={e.id}
                  className={`merge-row wrap-row alone speaker-row${isExcluded ? ' excluded' : ''}${e.locked ? ' locked' : ''}`}
                  onClick={() => onJump(e.id)}
                  title="点击定位到该片段"
                >
                  <div className="merge-head mono">
                    <span className="merge-idx">#{i + 1}</span>
                    {cue && (
                      <span>
                        {formatTimecode(e.start)} – {formatTimecode(e.end)}
                      </span>
                    )}
                    {e.locked && <span className="merge-lock">🔒</span>}
                    {e.status === 'multi' && <span className="speaker-badge warn">多说话人</span>}
                    {isExcluded && <span className="speaker-badge muted">已排除</span>}
                  </div>
                  <div className="wrap-text orig">
                    <span className="wrap-label">原文</span>
                    {e.original}
                  </div>
                  <div className="wrap-reason muted">⊘ {r.reason}</div>
                  {isExcluded && (
                    <div className="speaker-controls">
                      <button
                        className="mini"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setOverride(e.id, null);
                        }}
                      >
                        恢复自动选择
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {raw.trim() && table.segs.length > 0 && cues.length > 0 && applicable.length === 0 && (
        <div className="import-error">当前没有可写入的片段（全部跳过，或歧义尚未手工选择）。</div>
      )}

      <div className="merge-actions end">
        <button className="btn" onClick={cancelAll}>取消</button>
        <button className="btn primary" disabled={applicable.length === 0} onClick={confirm}>
          确认迁移（{applicable.length} 条）
        </button>
      </div>
    </section>
  );
}
