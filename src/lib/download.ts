import type { Cue } from './types';
import { serializeVTT } from './vtt';

/** 用浏览器下载一份 WebVTT 文件（复用同一套序列化与 Blob/anchor 下载方式）。 */
export function downloadVTT(cues: Cue[], preamble: string[], filename: string): void {
  const blob = new Blob([serializeVTT(cues, preamble)], { type: 'text/vtt;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 形如 subtitles-fixed-2026-09-26-08-30-00.vtt 的下载文件名。 */
export function timestampedFilename(prefix: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.vtt`;
}
