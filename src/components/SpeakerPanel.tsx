import { useMemo, useState } from 'react';
import type { Cue } from '../lib/types';
import { parseSpeakerTable, planSpeakers, type SpeakerRow } from '../lib/speaker';
import { formatTimecode } from '../lib/time';

interface Props {
  /** 当前字幕（已按 start 排序）；仅未锁定片段参与匹配，规划本身不改数据 */
  cues: Cue[];
  /** 确认写入：仅把选中片段的文本替换为带 <v> 标签的新正文，其余字段由调用方保留 */
  onApply: (entries: { id: string; text: string }[], count: number) => void;
  onJump: (id: string) => void;
}

/** 原角色列的显示：无标签 → （无）；标签无注解 → （未命名） */
function originalLabel(row: SpeakerRow): string {
  if (row.original === null) return '（无）';
  if (row.original === '') return '（未命名）';
  return row.original;
}

/**
 * 说话人标注迁移面板：
 * 粘贴「起点、终点、角色名」区间表，按时间重叠为未锁定片段自动选择角色
 * （同一角色多段区间累加，取重叠最长者）；无重叠跳过、同分列为歧义等待
 * 手工选择。预览逐条显示原角色、候选角色与跳过原因，可逐条排除或改选；
 * 输入或字幕变化时即时重算。确认后仅把单一说话人的正文包入或更新最外层
 * <v 角色名> 标签，其它内联标签、时间戳标签与换行原样保留。
 */
export default function SpeakerPanel({ cues, onApply, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Map<string, string>>(new Map());

  const unlockedCount = useMemo(() => cues.filter((c) => !c.locked).length, [cues]);
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);

  // 输入或字幕变化时重算预览
  const table = useMemo(() => parseSpeakerTable(raw), [raw]);
  const plan = useMemo(
    () => planSpeakers(cues, table, excluded, overrides),
    [cues, table, excluded, overrides],
  );

  const counts = useMemo(() => {
    let apply = 0;
    let ambiguous = 0;
    let skip = 0;
    let excl = 0;
    for (const r of plan.rows) {
      if (r.excluded) {
        excl++;
        continue;
      }
      if (r.status === 'apply') apply++;
      else if (r.status === 'ambiguous') ambiguous++;
      else skip++;
    }
    return { apply, ambiguous, skip, excluded: excl };
  }, [plan.rows]);

  function toggleExclude(id: string) {
    setExcluded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setOverride(id: string, name: string) {
    setOverrides((m) => {
      const next = new Map(m);
      if (name) next.set(id, name);
      else next.delete(id);
      return next;
    });
  }

  function confirm() {
    if (plan.changes.length === 0) return;
    onApply(
      plan.changes.map((c) => ({ id: c.id, text: c.text })),
      plan.changes.length,
    );
    setExcluded(new Set());
    setOverrides(new Map());
    setOpen(false);
  }

  if (!open) {
    return (
      <section className="panel speaker-panel">
        <h2>
          说话人标注迁移
          <span className="muted small ml">区间表 → &lt;v 角色&gt;</span>
        </h2>
        <p className="muted small">
          粘贴「起点、终点、角色名」区间表，按时间重叠为未锁定片段自动选择角色并预览；
          确认后把正文包入或更新最外层 <span className="mono">&lt;v 角色名&gt;</span> 标签。
        </p>
        <button className="btn primary" disabled={unlockedCount === 0} onClick={() => setOpen(true)}>
          粘贴角色区间表并预览
        </button>
        {unlockedCount === 0 && (
          <p className="muted small">当前没有未锁定片段（锁定片段不参与说话人标注）。</p>
        )}
      </section>
    );
  }

  return (
    <section className="panel speaker-panel">
      <h2>
        说话人标注迁移
        <span className="muted small ml">
          角色 {plan.roles.length} 个 · 区间 {table.intervals.length} 条
        </span>
      </h2>
      <p className="muted small">
        每行一条：<strong>起点、终点、角色名</strong>（制表符 / 逗号 / 空格分隔；时间码
        <span className="mono">00:01.500</span> 或纯秒数）。同一角色多段区间的重叠时长累加，
        取重叠最长者；同分列为歧义，需手工选择。输入或字幕变化时预览即时重算。
      </p>

      <textarea
        className="paste-area mono merge-paste speaker-paste"
        rows={6}
        placeholder={'00:00.500\t00:03.000\t张三\n00:03.200\t00:06.500\t李四'}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />

      {table.errors.length > 0 && (
        <div className="import-error speaker-errors">
          {table.errors.slice(0, 6).map((e) => (
            <div key={e.line}>
              第 {e.line} 行：{e.reason}（{e.raw}）
            </div>
          ))}
          {table.errors.length > 6 && <div>… 其余 {table.errors.length - 6} 行从略</div>}
        </div>
      )}

      {raw.trim() !== '' && table.intervals.length === 0 && (
        <div className="import-error">没有可用的角色区间，请先修正上方输入。</div>
      )}

      {table.intervals.length > 0 && (
        <>
          <div className="merge-summary">
            将写入 <strong>{plan.changes.length}</strong> 条 · 歧义 {counts.ambiguous} 条 ·
            跳过 {counts.skip} 条 · 已排除 {counts.excluded} 条 · 锁定跳过 {plan.lockedSkipped} 条
          </div>

          <div className="merge-section-label">
            匹配预览（{plan.rows.length} 条未锁定片段）
          </div>
          <ul className="merge-list speaker-list">
            {plan.rows.map((row, i) => {
              const cue = cueById.get(row.id);
              const best = row.overlaps[0];
              const candidateOverlap = row.candidate
                ? row.overlaps.find((o) => o.name === row.candidate)
                : undefined;
              return (
                <li
                  key={row.id}
                  className={`merge-row speaker-row ${row.status}${row.excluded ? ' excluded' : ''}`}
                  onClick={() => onJump(row.id)}
                  title="点击定位到该片段"
                >
                  <div className="merge-head mono">
                    <span className="merge-idx">#{i + 1}</span>
                    {cue && (
                      <span>
                        {formatTimecode(cue.start)} – {formatTimecode(cue.end)}
                      </span>
                    )}
                    <span className={`speaker-badge ${row.status}`}>
                      {row.status === 'apply' ? '写入' : row.status === 'ambiguous' ? '歧义' : '跳过'}
                    </span>
                    {row.manual && <span className="speaker-badge manual">手工</span>}
                    {row.excluded && <span className="speaker-badge skip">已排除</span>}
                  </div>
                  <div className="speaker-roles small">
                    原角色 <strong>{originalLabel(row)}</strong>
                    {row.status === 'apply' && row.candidate && (
                      <>
                        {' → '}
                        <strong className="speaker-candidate">{row.candidate}</strong>
                        {candidateOverlap && (
                          <span className="muted">（重叠 {candidateOverlap.seconds.toFixed(2)}s）</span>
                        )}
                      </>
                    )}
                    {row.status === 'ambiguous' && best && (
                      <span className="speaker-tied">
                        {' '}
                        同分 {best.seconds.toFixed(2)}s：{row.tied.join('、')}
                      </span>
                    )}
                  </div>
                  {cue && (
                    <div className="wrap-text orig">
                      <span className="wrap-label">正文</span>
                      {cue.text}
                    </div>
                  )}
                  {row.newText && (
                    <div className="wrap-text suggested">
                      <span className="wrap-label">写入</span>
                      {row.newText}
                    </div>
                  )}
                  {row.reason && <div className="speaker-reason">⏭ {row.reason}</div>}
                  {row.status !== 'skip' && (
                    <div className="speaker-controls" onClick={(e) => e.stopPropagation()}>
                      {!row.excluded && (
                        <select
                          className="speaker-select"
                          value={row.candidate ?? ''}
                          onChange={(e) => setOverride(row.id, e.target.value)}
                        >
                          <option value="">
                            {row.status === 'ambiguous' ? '请选择角色…' : '（自动结果）'}
                          </option>
                          {plan.roles.map((r) => (
                            <option key={r} value={r}>
                              {r}
                              {row.tied.length > 1 && row.tied.includes(r) ? '（同分）' : ''}
                            </option>
                          ))}
                        </select>
                      )}
                      <button className="mini" onClick={() => toggleExclude(row.id)}>
                        {row.excluded ? '恢复' : '排除'}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="merge-actions end">
        <button className="btn" onClick={() => setOpen(false)}>取消</button>
        <button
          className="btn primary"
          disabled={plan.changes.length === 0}
          onClick={confirm}
        >
          确认写入（{plan.changes.length} 条）
        </button>
      </div>
    </section>
  );
}
