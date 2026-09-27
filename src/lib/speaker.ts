import type { Cue } from './types';
import { parseTimecode } from './time';

/**
 * 说话人标注迁移：粘贴“起点、终点、角色名”表，按时间区间与未锁定字幕的
 * 重叠时长汇总各角色，为每条字幕选出重叠最长的角色；无重叠跳过，最长重叠
 * 并列列为歧义等待手工选择。确认后只把单一说话人的字幕正文包入或更新
 * 最外层 WebVTT <v 角色名> 标签，其它内联标签、时间戳标签与换行原样保留；
 * 正文已含多个说话人片段时不自动覆盖。
 */

/** 说话人表中的一条区间 */
export interface SpeakerSeg {
  start: number;
  end: number;
  name: string;
}

export interface SpeakerTable {
  /** 成功解析的说话区间（保持输入顺序） */
  segs: SpeakerSeg[];
  /** 被忽略的无效行数（时间码无法解析、终点不晚于起点、角色名为空等） */
  badLines: number;
}

/** 某角色与该 cue 的总重叠时长 */
export interface SpeakerCandidate {
  name: string;
  /** 重叠总时长（毫秒，时间戳本身为毫秒精度，按整数比较避免浮点噪声） */
  overlapMs: number;
}

export type SpeakerEntryStatus = 'unique' | 'ambiguous' | 'none' | 'locked' | 'multi';

export interface SpeakerEntry {
  id: string;
  status: SpeakerEntryStatus;
  start: number;
  end: number;
  locked: boolean;
  /** 当前 cue 正文（规划不修改数据） */
  original: string;
  /** 正文内说话人开标签数量（<v>、<v 名>、<v.类 名> 等） */
  voiceCount: number;
  /** 各说话人开标签中的角色名（按出现顺序，未命名标签不计入） */
  voiceNames: string[];
  /** 唯一说话人开标签位于正文最前且对应 </v> 位于正文最后（包住整个正文） */
  enclosing: boolean;
  /** 候选角色，按重叠时长降序、并列按名字升序 */
  candidates: SpeakerCandidate[];
  /** 自动选出的角色（仅 status === 'unique'） */
  chosen: string | null;
  /** 跳过/歧义原因（unique 时为 null） */
  reason: string | null;
}

export interface SpeakerPlan {
  entries: SpeakerEntry[];
}

// ---------- 说话人表解析 ----------

/**
 * 解析粘贴的“起点、终点、角色名”表。每行至少三列：
 * - 从电子表格粘贴时列之间多为 Tab，优先按 Tab 切分（角色名可含逗号）；
 * - 行内无 Tab 时退回按英文/中文逗号切分；再退回按连续空白切分，
 *   此时第 3 列起重新用空格拼回（允许 “Alice Smith” 这类带空格的名字）。
 * 第一条非空行若两列时间都无法解析，视为表头直接跳过（不计无效行）。
 */
export function parseSpeakerTable(raw: string): SpeakerTable {
  const segs: SpeakerSeg[] = [];
  let badLines = 0;
  let seenValid = false;

  for (const line of raw.split(/\r\n?|\n/)) {
    if (!line.trim()) continue;

    let parts: string[];
    if (line.includes('\t')) {
      parts = line.split('\t').map((s) => s.trim());
    } else if (/[,，]/.test(line)) {
      parts = line.split(/[,，]/).map((s) => s.trim());
    } else {
      parts = line.trim().split(/\s+/).map((s) => s.trim());
    }
    if (parts.length < 3) {
      badLines++;
      continue;
    }

    const start = parseTimecode(parts[0]);
    const end = parseTimecode(parts[1]);
    if (start === null) {
      // 首行两列时间均不可解析 => 表头；其余不可解析行计为无效
      if (!seenValid && end === null) continue;
      badLines++;
      continue;
    }
    if (end === null) {
      badLines++;
      continue;
    }
    const name = parts.slice(2).join(' ').trim();
    if (!(end > start) || !name || /[<>]/.test(name)) {
      badLines++;
      continue;
    }
    seenValid = true;
    segs.push({ start, end, name });
  }

  return { segs, badLines };
}

// ---------- 正文说话人标签扫描 ----------

interface ScannedTag {
  /** 标签起点（含 '<'） */
  start: number;
  /** 标签终点（不含，'>' 之后） */
  end: number;
  /** '<' 与 '>' 之间的内容 */
  inner: string;
}

/**
 * 扫描正文中的 <…> 标签：不跨行、内部不得再含 '<'；
 * 不完整的 “<” 按普通字符处理（与 term/wrap 的扫描口径一致）。
 */
function scanTags(text: string): ScannedTag[] {
  const tags: ScannedTag[] = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    const gt = text.indexOf('>', lt + 1);
    const nl = text.indexOf('\n', lt + 1);
    if (gt === -1 || (nl !== -1 && nl < gt) || text.slice(lt + 1, gt).includes('<')) {
      i = lt + 1;
      continue;
    }
    tags.push({ start: lt, end: gt + 1, inner: text.slice(lt + 1, gt) });
    i = gt + 1;
  }
  return tags;
}

/** 说话人开标签：<v>、<v 名>、<v.class 名>、<v.class.class 名>（大小写不敏感） */
function isVoiceOpen(inner: string): boolean {
  return /^v(?=$|[.\s>])/i.test(inner);
}

/** 说话人闭标签 </v>（允许空白） */
function isVoiceClose(inner: string): boolean {
  return /^\/v\s*$/i.test(inner);
}

/**
 * 解析说话人开标签内容，保留类名部分（<v.foo.bar 张三> 中的 ".foo.bar"）。
 * 类名 token 为紧跟 v 的 .xxx（到首个空白为止），其后的可见内容即角色名。
 */
function parseVoiceOpen(inner: string): { classes: string; name: string } {
  let rest = inner.slice(1); // 去掉开头的 v
  let classes = '';
  if (rest.startsWith('.')) {
    const m = /^\.[^\s>]*/.exec(rest);
    classes = m ? m[0] : '';
    rest = rest.slice(classes.length);
  }
  return { classes, name: rest.trim() };
}

export interface VoiceInfo {
  /** 说话人开标签数量 */
  count: number;
  /** 各开标签中的角色名（按出现顺序，未命名的不计） */
  names: string[];
  /** 首个开标签在正文最前（跳过前导空白）、最后一个 </v> 在正文最后（跳过尾随空白） */
  enclosing: boolean;
}

/** 检查正文内的说话人标签结构（不修改文本）。 */
export function inspectVoice(text: string): VoiceInfo {
  const tags = scanTags(text);
  const opens = tags.filter((t) => isVoiceOpen(t.inner));
  const closes = tags.filter((t) => isVoiceClose(t.inner));
  const names = opens.map((t) => parseVoiceOpen(t.inner).name).filter((n) => n.length > 0);

  let enclosing = false;
  if (opens.length === 1 && closes.length > 0) {
    const firstOpen = opens[0];
    const lastClose = closes[closes.length - 1];
    // 唯一开标签位于正文最前、最后一个 </v> 位于正文最后（跳过前导/尾随空白），
    // 且闭标签确实在开标签之后
    const coreStart = text.length - text.replace(/^\s+/, '').length;
    const coreEnd = text.replace(/\s+$/, '').length;
    enclosing =
      firstOpen.start === coreStart && lastClose.end === coreEnd && lastClose.start > firstOpen.end;
  }

  return { count: opens.length, names, enclosing };
}

/**
 * 把正文包入或更新最外层 <v 角色名> 标签：
 * - 正文已含 ≥2 个说话人片段 => 返回 null（不自动覆盖，由调用方跳过）；
 * - 恰好一个说话人标签且包住整个正文 => 仅更新开标签中的角色名（保留类名），
 *   其余字符（含闭标签位置、内联标签、时间戳标签、换行）原样保留；
 * - 其它情况（无说话人标签，或唯一标签只包住部分正文）=> 整个正文外层
 *   包一层 <v 名>…</v>，正文逐字符保留。
 */
export function applyVoiceTag(text: string, name: string): string | null {
  const info = inspectVoice(text);
  if (info.count >= 2) return null;

  if (info.count === 1) {
    const open = scanTags(text).find((t) => isVoiceOpen(t.inner));
    if (open && info.enclosing) {
      const { classes } = parseVoiceOpen(open.inner);
      const rebuilt = `<v${classes} ${name}>`;
      return text.slice(0, open.start) + rebuilt + text.slice(open.end);
    }
  }
  return `<v ${name}>${text}</v>`;
}

// ---------- 批量规划 ----------

/** 重叠时长（毫秒，取整避免浮点噪声；时间戳本身为毫秒精度） */
function overlapMs(cue: Cue, seg: SpeakerSeg): number {
  const lo = Math.max(cue.start, seg.start);
  const hi = Math.min(cue.end, seg.end);
  return hi > lo ? Math.round((hi - lo) * 1000) : 0;
}

/**
 * 为全部 cue 规划说话人迁移（保持传入顺序，通常已按 start 排序）。
 * 仅未锁定 cue 参与：按重叠总时长汇总各角色，选最长者；并列列为歧义。
 * 不修改输入。
 */
export function planSpeakerMigration(cues: Cue[], segs: SpeakerSeg[]): SpeakerPlan {
  const entries: SpeakerEntry[] = cues.map((cue) => {
    const info = inspectVoice(cue.text);

    const tally = new Map<string, number>();
    for (const seg of segs) {
      const ms = overlapMs(cue, seg);
      if (ms > 0) tally.set(seg.name, (tally.get(seg.name) ?? 0) + ms);
    }
    const candidates: SpeakerCandidate[] = [...tally.entries()]
      .map(([name, ms]) => ({ name, overlapMs: ms }))
      .sort((a, b) => b.overlapMs - a.overlapMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    let status: SpeakerEntryStatus;
    let chosen: string | null = null;
    let reason: string | null = null;

    if (cue.locked) {
      status = 'locked';
      reason = '锁定片段不参与说话人迁移';
    } else if (info.count >= 2) {
      status = 'multi';
      reason = `正文已含 ${info.count} 个说话人片段，不自动覆盖`;
    } else if (candidates.length === 0) {
      status = 'none';
      reason = '与说话人表无时间重叠';
    } else {
      const top = candidates[0].overlapMs;
      const tied = candidates.filter((c) => c.overlapMs === top);
      if (tied.length >= 2) {
        status = 'ambiguous';
        reason = `最长重叠并列（各 ${(top / 1000).toFixed(2)}s）：${tied
          .map((c) => c.name)
          .join('、')}，请手工选择`;
      } else {
        status = 'unique';
        chosen = tied[0].name;
      }
    }

    return {
      id: cue.id,
      status,
      start: cue.start,
      end: cue.end,
      locked: cue.locked,
      original: cue.text,
      voiceCount: info.count,
      voiceNames: info.names,
      enclosing: info.enclosing,
      candidates,
      chosen,
      reason,
    };
  });

  return { entries };
}
