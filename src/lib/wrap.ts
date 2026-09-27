import type { Cue } from './types';

/**
 * 智能分行：为字幕文本生成“不超过两行”的换行建议。
 *
 * 行宽按可见字素计算：中文及全角字符计 2，其余计 1；WebVTT 内联标签
 * （<b>、<v …> 等）与时间戳标签（<00:01.500>）不计宽，且作为原子单元
 * 不可拆开。行首/行尾的空白不计入宽度（渲染时会折叠）。
 *
 * 断点只选在空格（一段连续空白之后）、标点或字素边界；在所有可行断点中
 * 优先使两行宽差最小，其次偏好空格/既有换行之后、标点之后，再其次更少
 * 的行缘空白，最后取位置靠前者（保证确定性）。闭合标点不得出现在行首，
 * 开放标点不得出现在行尾。断点处的空格保留在原行尾，不删除任何字符；
 * 唯一的改动是增删换行符。
 *
 * 需要超过两行、单字素超过行宽、或标点禁则导致无合法断点时，返回无解原因。
 */

/** 闭合标点：不得出现在行首（即不可在其之前断行） */
const CLOSING_PUNCT = new Set([...'，。、；：？！…”’）】》」』〉〕〙〛,.;:!?)]}']);
/** 开放标点：不得出现在行尾（即不可在其之后断行） */
const OPENING_PUNCT = new Set([...'“‘（【《「『〈〔〘〚([{']);
/** 标点集合：在其后断行比在普通字素边界断行更自然（断点优先级用） */
const PUNCT = new Set([...CLOSING_PUNCT, ...OPENING_PUNCT, ...'—–']);

/**
 * 宽字素（计 2）：CJK 表意文字、假名、谚文音节、全角字符、CJK 标点与符号、
 * 竖排变体、emoji 及扩展区表意文字。半角片假名（FF61–FF9F）等不在其列，计 1。
 */
const WIDE_CHAR =
  /[\u1100-\u115F\u2E80-\u303E\u3040-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE1F\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

type TokenKind = 'tag' | 'char' | 'newline';

interface WrapToken {
  /** 原始文本片段（输出时原样保留） */
  raw: string;
  kind: TokenKind;
  /** 可见宽度：标签与换行为 0 */
  width: number;
  /** 空白字素（空格/制表符） */
  space: boolean;
  /** 闭合标点（禁止行首） */
  closing: boolean;
  /** 开放标点（禁止行尾） */
  opening: boolean;
  /** 标点（断点优先级用） */
  punct: boolean;
}

/** 字素切分：优先 Intl.Segmenter（ grapheme cluster ），退回码点切分 */
interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}
const SegmenterCtor = (Intl as unknown as {
  Segmenter?: new (
    locales?: string | string[],
    options?: { granularity?: string },
  ) => GraphemeSegmenter;
}).Segmenter;
let segmenter: GraphemeSegmenter | null = null;

function graphemes(s: string): string[] {
  if (SegmenterCtor) {
    if (!segmenter) segmenter = new SegmenterCtor(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(s), (x) => x.segment);
  }
  return Array.from(s);
}

function isWide(g: string): boolean {
  for (const ch of g) {
    if (WIDE_CHAR.test(ch)) return true;
  }
  return false;
}

function charToken(g: string): WrapToken {
  const space = g === ' ' || g === '\t';
  return {
    raw: g,
    kind: 'char',
    width: space ? 1 : isWide(g) ? 2 : 1,
    space,
    closing: CLOSING_PUNCT.has(g),
    opening: OPENING_PUNCT.has(g),
    punct: PUNCT.has(g),
  };
}

/**
 * 切分为 token 序列：内联标签/时间戳标签（<…>，不跨行、不嵌套 <）为原子
 * 零宽 token；既有换行为零宽边界 token；其余文本按字素切分。
 * 不完整的 “<” 按普通字符处理。
 */
function tokenize(text: string): WrapToken[] {
  const tokens: WrapToken[] = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    for (const g of graphemes(buf)) tokens.push(charToken(g));
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      flush();
      tokens.push({ raw: '\n', kind: 'newline', width: 0, space: false, closing: false, opening: false, punct: false });
      i++;
      continue;
    }
    if (ch === '<') {
      const end = text.indexOf('>', i + 1);
      const nl = text.indexOf('\n', i + 1);
      if (end !== -1 && (nl === -1 || end < nl) && !text.slice(i + 1, end).includes('<')) {
        flush();
        tokens.push({ raw: text.slice(i, end + 1), kind: 'tag', width: 0, space: false, closing: false, opening: false, punct: false });
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return tokens;
}

/** 一段 token 的可见行宽：标签/换行不计，行首行尾空白不计 */
function lineWidth(tokens: WrapToken[]): number {
  const chars = tokens.filter((t) => t.kind === 'char');
  let start = 0;
  let end = chars.length;
  while (start < end && chars[start].space) start++;
  while (end > start && chars[end - 1].space) end--;
  let w = 0;
  for (let i = start; i < end; i++) w += chars[i].width;
  return w;
}

/** 行内第一个可见字素（跳过标签与空白） */
function firstVisible(tokens: WrapToken[]): WrapToken | null {
  for (const t of tokens) {
    if (t.kind === 'char' && !t.space) return t;
  }
  return null;
}

/** 行内最后一个可见字素（跳过标签与空白） */
function lastVisible(tokens: WrapToken[]): WrapToken | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.kind === 'char' && !t.space) return t;
  }
  return null;
}

function trailingSpaces(tokens: WrapToken[]): number {
  let n = 0;
  for (let i = tokens.length - 1; i >= 0 && tokens[i].kind === 'char' && tokens[i].space; i--) n++;
  return n;
}

function leadingSpaces(tokens: WrapToken[]): number {
  let n = 0;
  for (let i = 0; i < tokens.length && tokens[i].kind === 'char' && tokens[i].space; i++) n++;
  return n;
}

/** 输出文本：换行 token 不写出（换行由断点统一处理），其余原样拼接 */
function emit(tokens: WrapToken[]): string {
  let s = '';
  for (const t of tokens) {
    if (t.kind !== 'newline') s += t.raw;
  }
  return s;
}

function splitLines(tokens: WrapToken[]): WrapToken[][] {
  const lines: WrapToken[][] = [[]];
  for (const t of tokens) {
    if (t.kind === 'newline') lines.push([]);
    else lines[lines.length - 1].push(t);
  }
  return lines;
}

/**
 * 断点候选：token k-1 与 k 之间。
 * - 换行 token 之前的边界与之后等价，只取之后（避免重复）；
 * - 空白字素之前不断开（一段连续空白只在其末尾之后断行），
 *   保证第二行不会以空白开头；
 * - 标签是原子 token，其内部天然不可拆。
 */
function isBreakCandidate(tokens: WrapToken[], k: number): boolean {
  const next = tokens[k];
  if (next.kind === 'newline') return false;
  if (next.kind === 'char' && next.space) return false;
  return true;
}

/** 断点优先级（越小越优）：空格/既有换行之后 > 标点之后 > 普通字素边界 */
function breakRank(tokens: WrapToken[], k: number, lastVis: WrapToken): number {
  const prev = tokens[k - 1];
  if (prev.kind === 'newline') return 0;
  if (prev.kind === 'char' && prev.space) return 0;
  if (lastVis.punct) return 1;
  return 2;
}

/** 当前文本是否已满足“≤2 行、每行不超宽、既有断点符合标点禁则” */
function currentIsValid(lines: WrapToken[][], maxWidth: number): boolean {
  if (lines.length > 2) return false;
  for (const line of lines) {
    if (!firstVisible(line)) return false; // 无可见字素的行（空行/纯标签行）
    if (lineWidth(line) > maxWidth) return false;
  }
  for (let i = 1; i < lines.length; i++) {
    const lastVis = lastVisible(lines[i - 1]);
    const firstVis = firstVisible(lines[i]);
    if (lastVis && lastVis.opening) return false;
    if (firstVis && firstVis.closing) return false;
  }
  return true;
}

export interface WrapSuggestion {
  /** 建议文本（至多一个换行） */
  text: string;
  /** 两行各自的可见宽度；单行时第二项为 0 */
  lineWidths: [number, number];
}

export type WrapAttempt =
  | { ok: true; suggestion: WrapSuggestion }
  | { ok: false; reason: string };

/**
 * 为单条字幕文本生成换行建议（不修改输入）。
 * 已满足约束时建议即原文；否则给出单行（删除既有换行）或最优两行断点；
 * 无解时给出原因。
 */
export function suggestWrap(text: string, maxWidth: number): WrapAttempt {
  const tokens = tokenize(text);

  // 纯标签/换行、没有可见字素：保持原文
  if (!tokens.some((t) => t.kind === 'char')) {
    return { ok: true, suggestion: { text, lineWidths: [0, 0] } };
  }

  // 已满足约束 → 保持原文
  const lines = splitLines(tokens);
  if (currentIsValid(lines, maxWidth)) {
    const widths: [number, number] = [lineWidth(lines[0]), lines.length > 1 ? lineWidth(lines[1]) : 0];
    return { ok: true, suggestion: { text, lineWidths: widths } };
  }

  // 单行即可放下 → 删除全部既有换行
  const total = lineWidth(tokens);
  if (total <= maxWidth) {
    return { ok: true, suggestion: { text: emit(tokens), lineWidths: [total, 0] } };
  }

  // 单字素超宽 → 直接无解
  let widest: WrapToken | null = null;
  for (const t of tokens) {
    if (t.kind === 'char' && !t.space && (!widest || t.width > widest.width)) widest = t;
  }
  if (widest && widest.width > maxWidth) {
    return {
      ok: false,
      reason: `单字素「${widest.raw}」宽度为 ${widest.width}，超过每行最大宽度 ${maxWidth}`,
    };
  }

  // 枚举全部合法断点：优先两行宽差最小，其次断点种类、行缘空白、位置靠前
  let best: { k: number; w1: number; w2: number; diff: number; rank: number; edge: number } | null = null;
  let punctLegalExists = false;
  for (let k = 1; k < tokens.length; k++) {
    if (!isBreakCandidate(tokens, k)) continue;
    const before = tokens.slice(0, k);
    const after = tokens.slice(k);
    const lastVis = lastVisible(before);
    const firstVis = firstVisible(after);
    if (!lastVis || !firstVis) continue; // 任一行无可见字素：不允许
    if (lastVis.opening || firstVis.closing) continue; // 标点禁则
    punctLegalExists = true;
    const w1 = lineWidth(before);
    const w2 = lineWidth(after);
    if (w1 > maxWidth || w2 > maxWidth) continue;
    const diff = Math.abs(w1 - w2);
    const rank = breakRank(tokens, k, lastVis);
    const edge = trailingSpaces(before) + leadingSpaces(after);
    if (
      !best ||
      diff < best.diff ||
      (diff === best.diff && rank < best.rank) ||
      (diff === best.diff && rank === best.rank && edge < best.edge) ||
      (diff === best.diff && rank === best.rank && edge === best.edge && k < best.k)
    ) {
      best = { k, w1, w2, diff, rank, edge };
    }
  }

  if (!best) {
    if (!punctLegalExists) {
      return {
        ok: false,
        reason: '受标点禁则限制（闭合标点不可在行首、开放标点不可在行尾），找不到合法断点',
      };
    }
    return {
      ok: false,
      reason: `内容过宽：按每行最大宽度 ${maxWidth} 两行放不下（需要超过两行）`,
    };
  }

  const wrapped = `${emit(tokens.slice(0, best.k))}\n${emit(tokens.slice(best.k))}`;
  return { ok: true, suggestion: { text: wrapped, lineWidths: [best.w1, best.w2] } };
}

/** 文本按单行渲染时的可见宽度（标签不计，行缘空白不计） */
export function visibleWidth(text: string): number {
  return lineWidth(tokenize(text));
}

export interface WrapChange {
  id: string;
  /** 原文（当前 cue 文本） */
  original: string;
  /** 建议文本（与原文不同，仅增删换行） */
  suggested: string;
  lineWidths: [number, number];
}

export interface WrapFailure {
  id: string;
  original: string;
  reason: string;
}

export interface WrapPlan {
  maxWidth: number;
  /** 有改动建议的未锁定片段 */
  changes: WrapChange[];
  /** 已满足约束、无需调整的未锁定片段 id */
  kept: string[];
  /** 无解的未锁定片段（保持原文） */
  failures: WrapFailure[];
  /** 跳过的锁定片段数 */
  lockedSkipped: number;
}

/**
 * 批量规划：仅处理未锁定片段，保持传入顺序；不修改输入。
 * 确认应用时只需把 changes 中各 id 的文本替换为 suggested。
 */
export function planSmartWrap(cues: Cue[], maxWidth: number): WrapPlan {
  const plan: WrapPlan = { maxWidth, changes: [], kept: [], failures: [], lockedSkipped: 0 };
  for (const cue of cues) {
    if (cue.locked) {
      plan.lockedSkipped++;
      continue;
    }
    const r = suggestWrap(cue.text, maxWidth);
    if (!r.ok) {
      plan.failures.push({ id: cue.id, original: cue.text, reason: r.reason });
    } else if (r.suggestion.text !== cue.text) {
      plan.changes.push({
        id: cue.id,
        original: cue.text,
        suggested: r.suggestion.text,
        lineWidths: r.suggestion.lineWidths,
      });
    } else {
      plan.kept.push(cue.id);
    }
  }
  return plan;
}
