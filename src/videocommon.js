/** 動画の変換で、方式を問わず共通に使う計算 */

/** 取り込むフレームレートの上限。60fps の動画はここまで落として容量を稼ぐ */
export const CAPTURE_FPS = 30;

/**
 * ビットレートを決める。
 * 画素数とフレームレートに比例させ、元の動画より高くならないように抑える。
 * @param {number} width
 * @param {number} height
 * @param {number} quality 0〜1
 * @param {number} [sourceBitrate] 元動画のビットレート（bps）
 * @returns {number} bps
 */
export function estimateVideoBitrate(width, height, quality, sourceBitrate = 0) {
  const level = Math.min(1, Math.max(0, (quality - 0.4) / 0.6));
  const bitsPerPixel = 0.02 + 0.08 * level;
  const estimate = width * height * CAPTURE_FPS * bitsPerPixel;
  const capped = sourceBitrate > 0 ? Math.min(estimate, sourceBitrate * 0.9) : estimate;
  return Math.round(Math.min(Math.max(capped, 200_000), 20_000_000));
}

/** H.264 は縦横が偶数である必要があるため、切り下げて揃える */
export function evenSize({ width, height }) {
  return {
    width: Math.max(2, width - (width % 2)),
    height: Math.max(2, height - (height % 2)),
  };
}
