import type { Cue } from './types';
import { parseTimecode } from './time';

/**
 * 说话人标注迁移：
 * 粘贴「起点、终点、角色名」区间表，按时间区间与未锁定 cue 的重叠时长
 * 汇总各角色，取重叠最长者作为候选；无重叠跳过，同分列为歧义等待手工选择。
 * 确认后仅把单一说话人的正文包入或更新最外层 <v 角色名> 标签：其它内联
 * 标签、时间戳标签与换行原样保留；正文已有多个 <v> 片段时不自动覆盖。
 */

export interface SpeakerInterval {
  /** 输入表中的行号（从 1 起，用于错误提示） */
  line: number;
  start: number; // 秒
  end: number; // 秒
  name: string;
}

export interface SpeakerTableError {
  line: number;
  raw: string;
  reason: string;
}

export interface SpeakerTable {
  intervals: SpeakerInterval[];
  /** 去重后的角色名（按首次出现顺序） */
  roles: string[];
  errors: SpeakerTableError[];
}

/** 时间字段：WebVTT 时间码（mm:ss.mmm / hh:mm:ss.mmm，. 或 ,），或纯秒数（如 12.5） */
const TIME_FIELD = String.raw`(?:\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}|\d+(?:\.\d+)?)`;
/** 一行：起点、终点、角色名；列间分隔为制表符/逗号/空白，角色名可含任意字符 */
const TABLE_LINE = new RegExp(
  `^\\s*(${TIME_FIELD})[\\t, ]+(${TIME_FIELD})[\\t, ]+(.+?)\\s*$`,
);

/** 时间字段求值：先按 WebVTT 时间码解析，再按纯秒数；失败返回 null */
function parseTimeField(raw: string): number | null {
  const t = parseTimecode(raw);
  if (t !== null) return t;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

/**
 * 解析「起点、终点、角色名」表。
 * 每行一条：时间码（00:01.500 / 01:02:03.456，逗号小数亦可）或纯秒数；
 * 列分隔为制表符、逗号或空白（角色名可含空格，前两列之后的内容整体作为角色名）。
 * 空行忽略；坏行记入 errors 并跳过，不影响其它行。同名角色的多段区间会合并汇总。
 */
export function parseSpeakerTable(input: string): SpeakerTable {
  const intervals: SpeakerInterval[] = [];
  const errors: SpeakerTableError[] = [];
  const roles: string[] = [];
  const seen = new Set<string>();

  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    const m = TABLE_LINE.exec(trimmed);
    if (!m) {
      errors.push({ line, raw: trimmed, reason: '格式无效（需要三列：起点、终点、角色名）' });
      return;
    }
    const start = parseTimeField(m[1]);
    const end = parseTimeField(m[2]);
    const name = m[3].trim();
    if (start === null || end === null) {
      errors.push({ line, raw: trimmed, reason: '时间无法解析（支持 00:01.500 时间码或纯秒数）' });
      return;
    }
    if (end <= start) {
      errors.push({ line, raw: trimmed, reason: '终点必须晚于起点' });
      return;
    }
    if (!name) {
      errors.push({ line, raw: trimmed, reason: '角色名为空' });
      return;
    }
    intervals.push({ line, start, end, name });
    if (!seen.has(name)) {
      seen.add(name);
      roles.push(name);
    }
  });

  return { intervals, roles, errors };
}

// ---------- 正文 <v> 标签 ----------

/** <v …> 开标签：v 后须紧跟空白、'.'（class）或 '>'，避免误配其它标签；不跨行 */
const VOICE_OPEN_G = /<v(?=[\s.>])[^<>\n]*>/g;
const VOICE_OPEN_FIRST = /<v(?=[\s.>])[^<>\n]*>/;

export interface VoiceInfo {
  /** 正文中 <v …> 开标签数量 */
  count: number;
  /** count === 1 时该标签的角色注解（可能为空字符串）；否则为 null */
  name: string | null;
}

/** 从 <v …> 开标签中取出角色注解（去掉 v 与 .class 部分） */
function voiceAnnotation(tag: string): string {
  const inner = tag.slice(1, -1);
  return inner.replace(/^v(\.[^\s>]*)?/, '').trim();
}

/** 统计正文中的 <v> 开标签数量与（唯一时的）角色注解；不修改输入 */
export function voiceInfo(text: string): VoiceInfo {
  const matches = text.match(VOICE_OPEN_G);
  if (!matches || matches.length === 0) return { count: 0, name: null };
  return {
    count: matches.length,
    name: matches.length === 1 ? voiceAnnotation(matches[0]) : null,
  };
}

/** 写入 <v> 标签前清洗角色名：尖括号与 & 会破坏 WebVTT 结构，直接移除 */
export function sanitizeVoiceName(name: string): string {
  return name.replace(/[<>&]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 把正文包入或更新最外层 <v 角色名> 标签（不修改输入）：
 * - 无 <v> 标签：整体包入 <v name>…</v>，内部内联标签、时间戳标签与换行原样保留；
 * - 恰好一个 <v> 开标签：仅更新其角色注解（保留 .class 与标签位置），其余内容不动；
 * - 两个及以上 <v> 开标签：返回 null（多个说话人片段，不自动覆盖）。
 * 角色名清洗后为空时同样返回 null。
 */
export function applyVoiceTag(text: string, name: string): string | null {
  const safe = sanitizeVoiceName(name);
  if (!safe) return null;
  const info = voiceInfo(text);
  if (info.count >= 2) return null;
  if (info.count === 0) return `<v ${safe}>${text}</v>`;
  return text.replace(VOICE_OPEN_FIRST, (tag) => {
    const cls = /^<v(\.[^\s>]+)?/.exec(tag)?.[1] ?? '';
    return `<v${cls} ${safe}>`;
  });
}

// ---------- 匹配规划 ----------

export interface SpeakerOverlap {
  name: string;
  seconds: number;
}

export type SpeakerRowStatus = 'apply' | 'ambiguous' | 'skip';

export interface SpeakerRow {
  id: string;
  status: SpeakerRowStatus;
  /** 已被用户逐条排除（不参与写入） */
  excluded: boolean;
  /** 候选来自手工选择（改选或歧义裁决） */
  manual: boolean;
  /** 原角色：正文唯一 <v> 标签的注解；无标签（或多标签）时为 null */
  original: string | null;
  /** 各角色与该片段时间区间的重叠时长（仅 > 0；按时长降序，等长按角色表顺序） */
  overlaps: SpeakerOverlap[];
  /** 将写入的角色（apply 时非空；歧义未选择时为 null） */
  candidate: string | null;
  /** 同分角色（歧义时 ≥ 2 个，按角色表顺序） */
  tied: string[];
  /** 跳过原因（status === 'skip'） */
  reason: string | null;
  /** 确认后写入的新正文（apply 时非空） */
  newText: string | null;
}

export interface SpeakerChange {
  id: string;
  text: string;
  name: string;
}

export interface SpeakerPlan {
  roles: string[];
  /** 未锁定 cue 的逐条结果（保持传入顺序） */
  rows: SpeakerRow[];
  lockedSkipped: number;
  /** 将写入的条目（status 为 apply 且未排除） */
  changes: SpeakerChange[];
}

const EPS = 1e-9;

/**
 * 规划说话人标注迁移（不修改输入）：
 * 仅处理未锁定 cue；对每个 cue 汇总各角色的时间重叠时长，取最长者；
 * 无重叠跳过，同分列为歧义（等待手工选择）。excluded / overrides 以 cue id
 * 为键：排除的条目不写入；手工选择优先于自动结果（角色已不在表中时忽略）。
 */
export function planSpeakers(
  cues: Cue[],
  table: SpeakerTable,
  excluded: ReadonlySet<string> = new Set<string>(),
  overrides: ReadonlyMap<string, string> = new Map<string, string>(),
): SpeakerPlan {
  const rows: SpeakerRow[] = [];
  const changes: SpeakerChange[] = [];
  let lockedSkipped = 0;

  const roleOrder = new Map(table.roles.map((r, i) => [r, i]));
  const byRole = new Map<string, { start: number; end: number }[]>();
  for (const iv of table.intervals) {
    const arr = byRole.get(iv.name);
    if (arr) arr.push({ start: iv.start, end: iv.end });
    else byRole.set(iv.name, [{ start: iv.start, end: iv.end }]);
  }

  for (const cue of cues) {
    if (cue.locked) {
      lockedSkipped++;
      continue;
    }
    const info = voiceInfo(cue.text);
    const isExcluded = excluded.has(cue.id);
    const base = {
      id: cue.id,
      excluded: isExcluded,
      manual: false,
      original: info.count === 1 ? info.name : null,
      overlaps: [] as SpeakerOverlap[],
      candidate: null as string | null,
      tied: [] as string[],
      reason: null as string | null,
      newText: null as string | null,
    };

    // 正文已有多个说话人片段：绝不自动覆盖
    if (info.count >= 2) {
      rows.push({
        ...base,
        status: 'skip',
        reason: `正文已有多个说话人片段（${info.count} 个 <v> 标签），不自动覆盖`,
      });
      continue;
    }

    // 汇总各角色与该 cue 的时间重叠时长（同一角色多段区间累加）
    const overlaps: SpeakerOverlap[] = [];
    for (const [name, ivs] of byRole) {
      let sec = 0;
      for (const iv of ivs) {
        const o = Math.min(cue.end, iv.end) - Math.max(cue.start, iv.start);
        if (o > 0) sec += o;
      }
      if (sec > EPS) overlaps.push({ name, seconds: sec });
    }
    overlaps.sort(
      (a, b) => b.seconds - a.seconds || roleOrder.get(a.name)! - roleOrder.get(b.name)!,
    );

    if (overlaps.length === 0) {
      rows.push({ ...base, status: 'skip', reason: '与角色区间表没有任何时间重叠' });
      continue;
    }

    const best = overlaps[0].seconds;
    const tied = overlaps.filter((o) => best - o.seconds <= EPS).map((o) => o.name);

    // 手工选择优先；角色已不在当前表中时忽略该选择，回到自动结果
    const ov = overrides.get(cue.id);
    const manual = ov !== undefined && byRole.has(ov);

    let status: SpeakerRowStatus;
    let candidate: string | null;
    if (manual) {
      status = 'apply';
      candidate = ov!;
    } else if (tied.length >= 2) {
      status = 'ambiguous';
      candidate = null;
    } else {
      status = 'apply';
      candidate = tied[0];
    }

    if (status === 'apply' && candidate) {
      const newText = applyVoiceTag(cue.text, candidate);
      if (newText === null) {
        rows.push({
          ...base,
          status: 'skip',
          overlaps,
          tied,
          reason: '角色名清洗后为空（含 <、>、& 等字符）',
        });
        continue;
      }
      if (newText === cue.text) {
        rows.push({
          ...base,
          status: 'skip',
          overlaps,
          tied,
          reason: `正文已标注为「${candidate}」，无需修改`,
        });
        continue;
      }
      rows.push({ ...base, status, manual, overlaps, tied, candidate, newText });
      if (!isExcluded) changes.push({ id: cue.id, text: newText, name: candidate });
    } else {
      rows.push({ ...base, status, overlaps, tied, candidate });
    }
  }

  return { roles: table.roles, rows, lockedSkipped, changes };
}
