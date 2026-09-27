import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Conflict, Cue, Settings } from './lib/types';
import { parseVTT } from './lib/vtt';
import { downloadVTT, timestampedFilename } from './lib/download';
import { detectIssues } from './lib/issues';
import { uid } from './lib/time';
import { SAMPLE_VTT } from './lib/sample';
import Timeline from './components/Timeline';
import Inspector from './components/Inspector';
import IssuesPanel from './components/IssuesPanel';
import SettingsPanel from './components/SettingsPanel';
import CueList from './components/CueList';
import ImportModal from './components/ImportModal';
import LayoutPreview from './components/LayoutPreview';
import SyncPanel from './components/SyncPanel';
import MergePanel from './components/MergePanel';
import ExcerptPanel from './components/ExcerptPanel';
import WrapPanel from './components/WrapPanel';
import TermPanel from './components/TermPanel';
import SpeakerPanel from './components/SpeakerPanel';

export default function App() {
  const initial = useMemo(() => parseVTT(SAMPLE_VTT), []);
  const [cues, setCues] = useState<Cue[]>(initial.cues);
  const [preamble, setPreamble] = useState<string[]>(initial.preamble);
  const [settings, setSettings] = useState<Settings>({ minDuration: 1, minGap: 0.1 });
  const [selectedId, setSelectedId] = useState<string | null>(initial.cues[0]?.id ?? null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [pps, setPps] = useState(60);
  const [toast, setToast] = useState<string | null>(null);
  const [syncGhosts, setSyncGhosts] = useState<Cue[]>([]);

  const scrollToRef = useRef<(id: string) => void>(() => {});

  const sortedCues = useMemo(
    () => [...cues].sort((a, b) => a.start - b.start || a.end - b.end),
    [cues],
  );
  const issues = useMemo(() => detectIssues(cues, settings), [cues, settings]);
  // 时间轴上的区间标注只反映时序问题；布局问题归入问题清单与布局预览
  const timingIssues = useMemo(() => issues.filter((i) => i.kind !== 'layout'), [issues]);
  const errorCount = issues.filter((i) => i.severity === 'error').length;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const registerScrollTo = useCallback((fn: (id: string) => void) => {
    scrollToRef.current = fn;
  }, []);

  function patchCue(id: string, patch: Partial<Cue>) {
    setConflict(null);
    setCues((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function deleteCue(id: string) {
    setCues((cs) => cs.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function duplicateCue(id: string) {
    setCues((cs) => {
      const src = cs.find((c) => c.id === id);
      if (!src) return cs;
      const copy: Cue = {
        ...src,
        id: uid(),
        start: src.end + settings.minGap,
        end: src.end + settings.minGap + (src.end - src.start),
        locked: false,
        text: src.text,
      };
      return [...cs, copy];
    });
  }

  function addCue() {
    const lastEnd = cues.reduce((m, c) => Math.max(m, c.end), 0);
    const cue: Cue = {
      id: uid(),
      identifier: '',
      start: lastEnd + settings.minGap,
      end: lastEnd + settings.minGap + Math.max(2, settings.minDuration),
      text: '新字幕',
      settings: '',
      locked: false,
    };
    setCues((cs) => [...cs, cue]);
    setSelectedId(cue.id);
  }

  function load(c: Cue[], p: string[]) {
    setCues(c);
    setPreamble(p);
    setConflict(null);
    setSelectedId(c[0]?.id ?? null);
  }

  function applyMerge(entries: { primaryId: string; mergedText: string }[], paired: number) {
    // 确认后仅把配对副轨文本作为新一行追加到主轨；时间、标识符、设置、锁定状态原样保留
    const byId = new Map(entries.map((e) => [e.primaryId, e.mergedText]));
    setCues((cs) => cs.map((c) => (byId.has(c.id) ? { ...c, text: byId.get(c.id)! } : c)));
    setConflict(null);
    setToast(`双语合并完成：已为 ${paired} 个主轨片段追加副轨文本，未配对内容未写入。`);
  }

  function applyWrap(entries: { id: string; text: string }[]) {
    // 确认后仅替换可行片段的文本（增删换行）；时间、标识符、设置、锁定状态与其余字符原样保留
    const byId = new Map(entries.map((e) => [e.id, e.text]));
    setCues((cs) => cs.map((c) => (byId.has(c.id) ? { ...c, text: byId.get(c.id)! } : c)));
    setConflict(null);
    setToast(`智能分行完成：已调整 ${entries.length} 个片段的换行，无解与锁定片段保持原样。`);
  }

  function applyTerms(entries: { id: string; text: string }[], hitCount: number) {
    // 确认后只写入命中的未锁定 cue 的正文；时间码、标识符、设置与锁定状态原样保留
    const byId = new Map(entries.map((e) => [e.id, e.text]));
    setCues((cs) => cs.map((c) => (byId.has(c.id) ? { ...c, text: byId.get(c.id)! } : c)));
    setConflict(null);
    setToast(`术语统一完成：已写入 ${entries.length} 个片段共 ${hitCount} 处替换，其余片段保持原样。`);
  }

  function applySpeakers(entries: { id: string; text: string }[], count: number) {
    // 确认后只写入选中未锁定 cue 的正文（包入/更新最外层 <v> 标签）；时间码、标识符、设置与锁定状态原样保留
    const byId = new Map(entries.map((e) => [e.id, e.text]));
    setCues((cs) => cs.map((c) => (byId.has(c.id) ? { ...c, text: byId.get(c.id)! } : c)));
    setConflict(null);
    setToast(`说话人标注完成：已为 ${count} 个片段写入/更新 <v> 标签，其余片段保持原样。`);
  }

  function exportVTT() {
    if (cues.length === 0) {
      setToast('没有可导出的片段。');
      return;
    }
    if (errorCount > 0) {
      setToast(`仍有 ${errorCount} 个错误（重叠/非法时间），已按当前内容导出，请先确认。`);
    } else {
      setToast('已导出 WebVTT 文件。');
    }
    downloadVTT(cues, preamble, timestampedFilename('subtitles-fixed'));
  }

  function exportExcerpt(planCues: { id: string; start: number; end: number; text: string }[]) {
    // 摘录为独立文件：复用现有序列化与浏览器下载；标识符/设置取自当前 cue，
    // 时间与（已改写时间戳标签的）文本取自裁剪计划，文件头原样保留。
    if (planCues.length === 0) {
      setToast('摘录区间内没有可导出的片段。');
      return;
    }
    const byId = new Map(planCues.map((c) => [c.id, c]));
    const excerptCues: Cue[] = cues
      .filter((c) => byId.has(c.id))
      .map((c) => {
        const p = byId.get(c.id)!;
        return { ...c, start: p.start, end: p.end, text: p.text, locked: false };
      });
    downloadVTT(excerptCues, preamble, timestampedFilename('subtitles-excerpt'));
    setToast(`已导出摘录 WebVTT 文件（${planCues.length} 条），当前编辑内容未改动。`);
  }

  const selected = cues.find((c) => c.id === selectedId) ?? null;
  const selectedIndex = selected ? sortedCues.findIndex((c) => c.id === selected.id) + 1 : 0;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">🎞️</span>
          <div>
            <h1>WebVTT 字幕时序修复器</h1>
            <span className="muted small">本地运行 · 拖动传播 · 锁定保护 · 布局预览 · 两点同步 · 双语合并 · 摘录导出 · 智能分行 · 术语统一 · 说话人标注</span>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => setShowImport(true)}>粘贴 / 导入</button>
          <button className="btn" onClick={addCue}>+ 新建片段</button>
          <button className="btn" onClick={() => load(initial.cues.map((c) => ({ ...c })), initial.preamble)}>
            载入示例
          </button>
          <button className="btn primary" onClick={exportVTT}>导出 WebVTT</button>
        </div>
      </header>

      <main className="layout">
        <div className="center-col">
          <Timeline
            cues={cues}
            settings={settings}
            selectedId={selectedId}
            conflict={conflict}
            issues={timingIssues}
            pps={pps}
            ghosts={syncGhosts}
            onPps={setPps}
            onSelect={setSelectedId}
            onCommit={setCues}
            onConflict={setConflict}
            registerScrollTo={registerScrollTo}
          />

          {conflict && (
            <div className="conflict-banner">
              <span>⛔ 约束无解，已撤销本次调整：{conflict.reason}</span>
              <button
                className="mini"
                onClick={() => {
                  setConflict(null);
                }}
              >
                消除标记
              </button>
            </div>
          )}

          <CueList
            cues={sortedCues}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              scrollToRef.current(id);
            }}
            onToggleLock={(id) => patchCue(id, { locked: !cues.find((c) => c.id === id)?.locked })}
          />
        </div>

        <aside className="side-col">
          <SettingsPanel settings={settings} onChange={setSettings} />
          <SyncPanel
            cues={sortedCues}
            settings={settings}
            onPreview={setSyncGhosts}
            onApply={(next, affected) => {
              // 确认后一次性写入全部校准结果
              setCues(next);
              setConflict(null);
              setSyncGhosts([]);
              setToast(`两点同步完成：已校准 ${affected} 个片段。`);
            }}
            onJump={(id) => {
              setSelectedId(id);
              scrollToRef.current(id);
            }}
          />
          <MergePanel
            cues={sortedCues}
            onApply={applyMerge}
            onJump={(id) => {
              setSelectedId(id);
              scrollToRef.current(id);
            }}
          />
          <ExcerptPanel
            cues={sortedCues}
            onDownload={exportExcerpt}
            onJump={(id) => {
              setSelectedId(id);
              scrollToRef.current(id);
            }}
          />
          <WrapPanel
            cues={sortedCues}
            onApply={applyWrap}
            onJump={(id) => {
              setSelectedId(id);
              scrollToRef.current(id);
            }}
          />
          <TermPanel
            cues={sortedCues}
            onApply={applyTerms}
            onJump={(id) => {
              setSelectedId(id);
              scrollToRef.current(id);
            }}
          />
          <SpeakerPanel
            cues={sortedCues}
            onApply={applySpeakers}
            onJump={(id) => {
              setSelectedId(id);
              scrollToRef.current(id);
            }}
          />
          <LayoutPreview cue={selected} />
          <Inspector
            cue={selected}
            index={selectedIndex}
            onPatch={patchCue}
            onDelete={deleteCue}
            onDuplicate={duplicateCue}
          />
          <IssuesPanel
            issues={issues}
            onJump={(issue) => {
              const id = issue.cueIds[0];
              if (id) {
                setSelectedId(id);
                scrollToRef.current(id);
              }
            }}
          />
        </aside>
      </main>

      {showImport && (
        <ImportModal
          hasCues={cues.length > 0}
          onClose={() => setShowImport(false)}
          onLoad={load}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
