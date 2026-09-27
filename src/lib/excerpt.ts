import type { Cue } from './types';
import { parseTimecode, formatTimecode } from './time';

/** 左闭右开摘录区间内、裁剪后的单条 cue（时间已统一减去摘录起点） */
export interface ExcerptCue {
  id: string;
  /** 裁剪并偏移后的开始（相对摘录起点，秒） */
  start: number;
  /** 裁剪并偏移后的结束（相对摘录起点，秒） */
  end: number;
  /** 重写时间戳标签后的文本 */
  text: string;
  /** 裁剪前的开始（原时间轴，秒） */
  origStart: number;
  /** 裁剪前的结束（原时间轴，秒） */
  origEnd: number;
}

export interface ExcerptPlan {
  from: number;
  to: number;
  /** 命中的 cue（保持原时间轴顺序） */
  cues: ExcerptCue[];
  /** 时间范围无效时的原因；为 null 表示区间有效 */
  error: string | null;
}

/**
 * 匹配 cue 文本中的 WebVTT 时间戳标签，如 <00:01.500>。
 * 标签内时间戳无法解析时（如 <00:00>）不作为时间戳标签处理，原样保留。
 */
const TIMESTAMP_TAG = /<([^<>]*)>/g;

/**
 * 重写 cue 文本中的时间戳标签：
 * 仅保留落在裁剪后 cue 内部（[clipStart, clipEnd)，左闭右开）的标签，
 * 其余时间戳标签整体删除；保留的标签统一减去摘录起点 from。
 * 普通内联标签（如 <b>、</b>、<v.zh>）与文字一律原样保留。
 */
export function rewriteTimestampTags(text: string, clipStart: number, clipEnd: number, from: number): string {
  return text.replace(TIMESTAMP_TAG, (whole, inner: string) => {
    const t = parseTimecode(inner);
    if (t === null) return whole; // 不是时间戳标签：原样保留
    if (t >= clipStart && t < clipEnd) {
      return `<${formatTimecode(t - from)}>`;
    }
    return '';
  });
}

/**
 * 规划片段摘录：仅纳入与左闭右开区间 [from, to) 有正时长交集的 cue
 * （仅端点相接不纳入）。各 cue 起止裁到交集后统一减去摘录起点；
 * cue 文本中的时间戳标签按同一规则裁剪/改写。
 * 不修改输入数组，可直接交给 serializeVTT 序列化。
 */
export function planExcerpt(cues: Cue[], from: number, to: number): ExcerptPlan {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0) {
    return { from, to, cues: [], error: '时间范围无效：起始时间不得早于 00:00.000。' };
  }
  if (to <= from) {
    return { from, to, cues: [], error: `时间范围无效：结束时间（${formatTimecode(to)}）必须晚于开始时间（${formatTimecode(from)}）。` };
  }

  const result: ExcerptCue[] = [];
  for (const cue of cues) {
    const clipStart = Math.max(cue.start, from);
    const clipEnd = Math.min(cue.end, to);
    // 左闭右开：正时长交集才纳入；仅端点相接（clipEnd <= clipStart）排除
    if (clipEnd <= clipStart) continue;
    result.push({
      id: cue.id,
      start: clipStart - from,
      end: clipEnd - from,
      text: rewriteTimestampTags(cue.text, clipStart, clipEnd, from),
      origStart: cue.start,
      origEnd: cue.end,
    });
  }

  return { from, to, cues: result, error: null };
}
