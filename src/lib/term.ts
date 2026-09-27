import type { Cue } from './types';
import { parseTimecode } from './time';

/**
 * 术语统一：对 cue 正文按“可见文字”做多规则批量替换。
 *
 * 匹配规则：
 * - 匹配以**可见文字**为准：WebVTT 内联格式标签（<b>、<v …> 等，含无法解析
 *   为时间戳的 <00:00> 之类）不计入可见文字，原词允许跨越这些标签；
 * - **时间戳标签**（<00:01.500> 等可解析为时间的标签）与换行符是匹配边界，
 *   原词不得跨越它们，标签本身原样保留；
 * - 同一位置多条规则同时命中时取**最长原词**，等长按**输入顺序**取最先者；
 * - 基于原文**一次匹配**（leftmost-longest）：替换后的文字不再参与匹配，
 *   相邻命中互不重叠。
 *
 * 替换时保留所有标签原文、出现顺序以及标签外未命中的文字：
 * - 命中范围之前/之后的标签留在替换内容之外的原位置；
 * - 夹在命中字素之间的内联标签按其相对位置插入替换词对应缝隙，
 *   替换词较短时贴在替换词末尾，同缝隙的多个标签保持原顺序。
 */

export interface TermRule {
  /** 原词（按可见字素精确匹配，区分大小写） */
  from: string;
  /** 替换词（可为空字符串，表示删除原词） */
  to: string;
}

export interface TermRuleHit {
  /** 命中的规则序号（输入数组下标，空原词与重复原词不占用新序号） */
  ruleIndex: number;
  count: number;
}

export interface TermReplaceResult {
  text: string;
  /** 本条文本的命中（替换）总次数 */
  hits: number;
  /** 每条规则的命中次数（仅列 count > 0，按规则序号排序） */
  ruleHits: TermRuleHit[];
}

export interface TermChange {
  id: string;
  /** 原文（当前 cue 文本） */
  original: string;
  /** 替换后的正文 */
  replaced: string;
  hits: number;
  ruleHits: TermRuleHit[];
}

/** 生效规则（空原词与重复原词被忽略） */
export interface EffectiveRule extends TermRule {
  /** 该规则在输入数组中的序号（ruleHits.ruleIndex 与此对应） */
  inputIndex: number;
}

export interface TermPlan {
  /** 实际生效的规则（非空原词、去重后，按输入顺序） */
  rules: EffectiveRule[];
  /** 有命中的未锁定片段（保持传入顺序） */
  changes: TermChange[];
  /** 跳过的锁定片段数 */
  lockedSkipped: number;
  /** 无命中的未锁定片段数 */
  unlockedUnchanged: number;
  /** 全部片段命中总次数 */
  totalHits: number;
}

// ---------- 可见文字切分 ----------

interface CharToken {
  kind: 'char';
  g: string;
}
interface TagToken {
  kind: 'tag';
  raw: string;
}
type TermToken = CharToken | TagToken;

/** 文本段：在其内联标签之间按可见字素匹配 */
interface TextSeg {
  kind: 'text';
  tokens: TermToken[];
}
/** 边界段：时间戳标签或换行，原样写出且不允许原词跨越 */
interface BoundarySeg {
  kind: 'boundary';
  raw: string;
}
type Seg = TextSeg | BoundarySeg;

/** 字素切分：优先 Intl.Segmenter（grapheme cluster），退回码点切分 */
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

/**
 * 切分为文本段 / 边界段序列。
 * - 可解析为时间戳的 <…> 标签与换行符 => 边界段（匹配边界，原样保留）；
 * - 其它 <…>（<b>、<v …>、<00:00> 等）=> 文本段内的原子标签 token；
 * - 其余文本按字素切为字符 token。不完整的 “<” 按普通字符处理。
 */
function segmentize(text: string): Seg[] {
  const segs: Seg[] = [];
  let tokens: TermToken[] = [];
  let buf = '';

  const flushBuf = () => {
    if (!buf) return;
    for (const g of graphemes(buf)) tokens.push({ kind: 'char', g });
    buf = '';
  };
  const flushText = () => {
    flushBuf();
    if (tokens.length) {
      segs.push({ kind: 'text', tokens });
      tokens = [];
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      flushText();
      segs.push({ kind: 'boundary', raw: '\n' });
      i++;
      continue;
    }
    if (ch === '<') {
      const end = text.indexOf('>', i + 1);
      const nl = text.indexOf('\n', i + 1);
      if (end !== -1 && (nl === -1 || end < nl) && !text.slice(i + 1, end).includes('<')) {
        const raw = text.slice(i, end + 1);
        const inner = text.slice(i + 1, end);
        flushBuf();
        if (parseTimecode(inner) !== null) {
          flushText();
          segs.push({ kind: 'boundary', raw });
        } else {
          tokens.push({ kind: 'tag', raw });
        }
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flushText();
  return segs;
}

// ---------- 规则编译与匹配 ----------

interface CompiledRule {
  /** 原始输入序号（用于等长决胜与命中统计） */
  index: number;
  from: string[];
  to: string[];
}

/**
 * 编译规则：忽略空原词；重复原词只保留最先输入的一条（等长决胜按输入顺序）。
 */
function compileRules(rules: TermRule[]): CompiledRule[] {
  const seen = new Set<string>();
  const out: CompiledRule[] = [];
  rules.forEach((r, index) => {
    if (r.from.length === 0) return;
    if (seen.has(r.from)) return;
    seen.add(r.from);
    out.push({ index, from: graphemes(r.from), to: graphemes(r.to) });
  });
  return out;
}

interface Match {
  /** 可见字素起（含） */
  s: number;
  /** 可见字素止（不含） */
  e: number;
  ruleIndex: number;
}

function emitToken(t: TermToken): string {
  return t.kind === 'char' ? t.g : t.raw;
}

/**
 * 对单条 cue 文本执行术语替换（不修改输入）。无生效规则时原样返回。
 */
export function applyTerminology(text: string, rules: TermRule[]): TermReplaceResult {
  const compiled = compileRules(rules);
  if (compiled.length === 0) return { text, hits: 0, ruleHits: [] };

  // 最长原词优先，等长按输入顺序（index）——同位置遍历时第一个可匹配者即胜
  const byLength = [...compiled].sort((a, b) =>
    b.from.length - a.from.length || a.index - b.index,
  );
  const byIndex = new Map(compiled.map((r) => [r.index, r]));

  const counts = new Map<number, number>();
  let hits = 0;
  let out = '';

  for (const seg of segmentize(text)) {
    if (seg.kind === 'boundary') {
      out += seg.raw;
      continue;
    }
    const tokens = seg.tokens;

    // 可见字素序列及其所在 token 下标
    const visible: string[] = [];
    const tokAtVis: number[] = [];
    tokens.forEach((t, k) => {
      if (t.kind === 'char') {
        visible.push(t.g);
        tokAtVis.push(k);
      }
    });

    // 一次匹配：从左到右，每处取最长命中，命中区间整体跳过（替换结果不再匹配）
    const matches: Match[] = [];
    let i = 0;
    while (i < visible.length) {
      let best: Match | null = null;
      for (const r of byLength) {
        const L = r.from.length;
        if (L > visible.length - i) continue;
        // byLength 已保证“最长优先、等长输入顺序优先”，首个可匹配者即胜
        let eq = true;
        for (let j = 0; j < L; j++) {
          if (r.from[j] !== visible[i + j]) {
            eq = false;
            break;
          }
        }
        if (eq) {
          best = { s: i, e: i + L, ruleIndex: r.index };
          break;
        }
      }
      if (best) {
        matches.push(best);
        counts.set(best.ruleIndex, (counts.get(best.ruleIndex) ?? 0) + 1);
        hits++;
        i = best.e;
      } else {
        i++;
      }
    }

    // 按 token 原样重建：未命中部分直出；命中部分在保留内联标签的同时换入替换词
    let t = 0;
    for (const m of matches) {
      const tFirst = tokAtVis[m.s];
      const tLast = tokAtVis[m.e - 1];

      // 命中范围之外的标签（首字素之前 / 末字素之后）随未命中部分保持原位
      for (; t < tFirst; t++) out += emitToken(tokens[t]);

      // 夹在命中字素之间的标签放入替换词缝隙：原缝隙 gap（1..L-1）直接对应
      // 替换词第 gap 个可见字素之前；超出替换词长度时贴在替换词末尾。
      // gap 随扫描严格递增，故映射单调不减，多个标签落同缝时保持原顺序；
      // 替换词为空时全部贴在替换内容（空串）之后。
      const rule = byIndex.get(m.ruleIndex)!;
      const rep = rule.to;
      const inner: { gap: number; raw: string }[] = [];
      let passed = 0;
      for (let k = tFirst + 1; k < tLast; k++) {
        const tk = tokens[k];
        if (tk.kind === 'char') passed++;
        else inner.push({ gap: passed + 1, raw: tk.raw });
      }

      let pos = 0;
      for (const it of inner) {
        const upto = Math.min(it.gap, rep.length);
        while (pos < upto) {
          out += rep[pos];
          pos++;
        }
        out += it.raw;
      }
      while (pos < rep.length) {
        out += rep[pos];
        pos++;
      }

      t = tLast + 1;
    }
    // 最后一处命中之后的剩余 token（标签与未命中文字）原样输出
    for (; t < tokens.length; t++) out += emitToken(tokens[t]);
  }

  const ruleHits = [...counts.entries()]
    .map(([ruleIndex, count]) => ({ ruleIndex, count }))
    .sort((a, b) => a.ruleIndex - b.ruleIndex);
  return { text: out, hits, ruleHits };
}

/**
 * 批量规划：仅处理未锁定片段，保持传入顺序；不修改输入。
 * 确认应用时只需把 changes 中各 id 的文本替换为 replaced。
 */
export function planTerminology(cues: Cue[], rules: TermRule[]): TermPlan {
  const compiled = compileRules(rules);
  const effective: EffectiveRule[] = [...compiled]
    .sort((a, b) => a.index - b.index)
    .map((r) => ({ from: r.from.join(''), to: r.to.join(''), inputIndex: r.index }));

  const changes: TermChange[] = [];
  let lockedSkipped = 0;
  let unlockedUnchanged = 0;
  let totalHits = 0;

  for (const cue of cues) {
    if (cue.locked) {
      lockedSkipped++;
      continue;
    }
    const res = applyTerminology(cue.text, rules);
    if (res.hits > 0) {
      changes.push({
        id: cue.id,
        original: cue.text,
        replaced: res.text,
        hits: res.hits,
        ruleHits: res.ruleHits,
      });
      totalHits += res.hits;
    } else {
      unlockedUnchanged++;
    }
  }

  return { rules: effective, changes, lockedSkipped, unlockedUnchanged, totalHits };
}
