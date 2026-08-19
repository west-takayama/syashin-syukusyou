/** 表示用の小さなヘルパー群 */

/**
 * バイト数を「1.2 MB」のような読みやすい文字列にする。
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * 削減率（%）。0 以下（＝縮まなかった）の場合は 0 を返す。
 * @param {number} before
 * @param {number} after
 */
export function savingPercent(before, after) {
  if (!before || after >= before) return 0;
  return Math.round(((before - after) / before) * 100);
}

/**
 * 出力ファイル名を作る。拡張子は出力形式に合わせて付け替える。
 * @param {string} name 元のファイル名
 * @param {string} mime 出力の MIME タイプ（"video/mp4;codecs=..." のような指定も可）
 * @param {string} [suffix] 拡張子の前に付ける文字列
 */
export function outputName(name, mime, suffix = '-min') {
  const extensions = {
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/png': 'png',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  };
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const original = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const ext = extensions[String(mime).split(';')[0].trim()] ?? original ?? 'jpg';
  return `${stem}${suffix}.${ext}`;
}

/**
 * 秒数を「1:05」「1:02:03」のような表記にする。
 * @param {number} seconds
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const total = Math.round(seconds);
  const pad = (value) => String(value).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(total % 60)}`;
  return `${minutes}:${pad(total % 60)}`;
}

/**
 * 秒数を「20 秒」「1 分 35 秒」のように、ざっくり日本語で表す。
 * @param {number} seconds
 */
export function formatApprox(seconds) {
  if (!Number.isFinite(seconds)) return '-';
  const total = Math.max(0, Math.ceil(seconds));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/**
 * 残り時間の表示。
 * @param {number} seconds
 */
export function formatRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'まもなく完了';
  return `残り約 ${formatApprox(seconds)}`;
}

/**
 * 長辺を maxEdge に収めるサイズを求める（拡大はしない）。
 * @param {number} width
 * @param {number} height
 * @param {number} maxEdge 0 以下なら等倍
 */
export function fitSize(width, height, maxEdge) {
  const longEdge = Math.max(width, height);
  if (!maxEdge || maxEdge <= 0 || longEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
