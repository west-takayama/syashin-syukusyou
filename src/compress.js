/**
 * 画像の縮小・再圧縮の本体。
 *
 * 処理はすべてブラウザ内で完結し、画像がネットワークに出ることはない。
 */

import { extractExif, insertExif, readOrientation, rebuildExif } from './exif.js';
import { fitSize, outputName } from './format.js';

/** @typedef {'auto'|'image/jpeg'|'image/webp'|'image/png'} OutputFormat */
/** @typedef {'strip'|'keep'|'keep-gps'} MetadataMode */

/**
 * @typedef {object} CompressOptions
 * @property {number} maxEdge 長辺の上限（0 なら等倍）
 * @property {number} quality 0〜1
 * @property {OutputFormat} format
 * @property {MetadataMode} metadata
 * @property {boolean} keepLargerOriginal 元より大きくなったら元ファイルを使う
 */

/**
 * @typedef {object} CompressResult
 * @property {Blob} blob 出力データ
 * @property {string} name 出力ファイル名
 * @property {string} mime
 * @property {number} width
 * @property {number} height
 * @property {number} sourceWidth
 * @property {number} sourceHeight
 * @property {boolean} skipped 元ファイルをそのまま使ったか
 */

const ALPHA_CAPABLE_SOURCES = /^image\/(png|gif|webp|avif|svg\+xml)$/;

/**
 * 向きの自動補正を調べるための 2×1 の JPEG（Exif の Orientation=6 付き）。
 * 補正されるデコーダでは 1×2（縦長）として読み込まれる。
 */
const ORIENTATION_PROBE = 'data:image/jpeg;base64,/9j/4QAiRXhpZgAASUkqAAgAAAABABIBAwABAAAABgAAAAAAAAD/2wBDAFA3PEY8MlBGQUZaVVBfeMiCeG5uePWvuZHI////////////////////////////////////////////////////2wBDAVVaWnhpeOuCguv/////////////////////////////////////////////////////////////////////////wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAZEAEAAgMAAAAAAAAAAAAAAAAAAQMzcrH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AqpwV6xwAH//Z';

/** @type {Map<string, Promise<boolean>>} */
const orientationProbes = new Map();

let webpSupport = null;

/** この端末の Canvas が WebP を書き出せるか（1 度だけ調べる） */
export function canEncodeWebp() {
  if (webpSupport === null) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    webpSupport = canvas.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpSupport;
}

/**
 * 1 枚を縮小・再圧縮する。
 * @param {File} file
 * @param {CompressOptions} options
 * @returns {Promise<CompressResult>}
 */
export async function compressImage(file, options) {
  const decoded = await decode(file);
  try {
    // Exif は「向きを自分で直すとき」と「撮影情報を残すとき」にだけ読む
    const needsExif = isJpeg(file) && (options.metadata !== 'strip' || !decoded.orientationApplied);
    const exif = needsExif ? extractExif(new Uint8Array(await file.arrayBuffer())) : null;

    const orientation = decoded.orientationApplied ? 1 : readOrientation(exif);
    const swap = orientation >= 5 && orientation <= 8;
    const sourceWidth = swap ? decoded.height : decoded.width;
    const sourceHeight = swap ? decoded.width : decoded.height;
    const target = fitSize(sourceWidth, sourceHeight, options.maxEdge);

    const canvas = render(decoded.source, orientation, sourceWidth, sourceHeight, target);
    const mime = pickMime(file, options, canvas);
    const flatten = mime === 'image/jpeg' && mayHaveAlpha(file) && hasAlpha(canvas);
    const blob = await encode(canvas, mime, options.quality, flatten);
    releaseCanvas(canvas);

    const withExif = await attachExif(blob, mime, options, target, exif);
    if (options.keepLargerOriginal && withExif.size >= file.size) {
      return {
        blob: file, name: file.name, mime: file.type || mime,
        width: sourceWidth, height: sourceHeight, sourceWidth, sourceHeight, skipped: true,
      };
    }
    return {
      blob: withExif, name: outputName(file.name, mime), mime,
      width: target.width, height: target.height, sourceWidth, sourceHeight, skipped: false,
    };
  } finally {
    if (typeof decoded.source.close === 'function') decoded.source.close();
    if (decoded.revoke) URL.revokeObjectURL(decoded.revoke);
  }
}

function isJpeg(file) {
  return file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name);
}

// ---------------------------------------------------------------------------
// デコード
// ---------------------------------------------------------------------------

/**
 * Exif の向きをデコーダが自動で直すかどうかはブラウザ次第で、
 * Chromium は imageOrientation: 'none' を指定しても直してしまう。
 * 推測せずに、判定用の小さな画像を読ませて実際の挙動を調べる。
 * @param {string} kind 読み込み経路ごとに結果を覚えておくためのキー
 * @param {(url: string) => Promise<{width: number, height: number}>} measure
 * @returns {Promise<boolean>}
 */
function decoderAppliesOrientation(kind, measure) {
  if (!orientationProbes.has(kind)) {
    orientationProbes.set(kind, measure(ORIENTATION_PROBE)
      .then((size) => size.height > size.width) // 縦長になっていれば補正されている
      .catch(() => true)); // 判定できないときは今どきの挙動（補正あり）とみなす
  }
  return orientationProbes.get(kind);
}

async function measureWithImageBitmap(url) {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'none' });
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  return size;
}

async function measureWithImageElement(url) {
  const image = await loadImage(url);
  return { width: image.naturalWidth, height: image.naturalHeight };
}

/** 画像を読み込み、向きが補正済みかどうかも合わせて返す */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'none' });
      return {
        source: bitmap, width: bitmap.width, height: bitmap.height,
        orientationApplied: await decoderAppliesOrientation('bitmap', measureWithImageBitmap),
      };
    } catch {
      // 古い Safari など。<img> にフォールバックする
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    return {
      source: image, width: image.naturalWidth, height: image.naturalHeight,
      orientationApplied: await decoderAppliesOrientation('element', measureWithImageElement),
      revoke: url,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('この画像はブラウザで読み込めませんでした'));
    image.src = url;
  });
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

/**
 * 向きを直しつつ目標サイズまで縮小し、Canvas を返す。
 * 一気に縮小するとギザギザになりやすいので、半分ずつ段階的に縮める。
 */
function render(source, orientation, sourceWidth, sourceHeight, target) {
  const steps = [];
  let width = sourceWidth;
  let height = sourceHeight;
  while (width > target.width * 2 && height > target.height * 2) {
    width = Math.max(target.width, Math.round(width / 2));
    height = Math.max(target.height, Math.round(height / 2));
    steps.push({ width, height });
  }
  if (steps.length === 0 || width !== target.width || height !== target.height) {
    steps.push(target);
  }

  let canvas = createCanvas(steps[0].width, steps[0].height);
  drawOriented(canvas, source, orientation);
  for (const step of steps.slice(1)) {
    const next = createCanvas(step.width, step.height);
    context(next).drawImage(canvas, 0, 0, step.width, step.height);
    releaseCanvas(canvas);
    canvas = next;
  }
  return canvas;
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Exif の Orientation (1〜8) に合わせて回転・反転しながら描画する */
function drawOriented(canvas, source, orientation) {
  const ctx = context(canvas);
  const { width, height } = canvas;
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, width, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, width, height); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, height); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, width, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, width, height); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, height); break;
    default: break;
  }
  const swap = orientation >= 5 && orientation <= 8;
  ctx.drawImage(source, 0, 0, swap ? height : width, swap ? width : height);
}

/** iOS で Canvas のメモリを速やかに手放すための後始末 */
function releaseCanvas(canvas) {
  canvas.width = 1;
  canvas.height = 1;
}

/** 透過を持ちうる形式か（JPEG に対して無駄なピクセル走査をしないため） */
function mayHaveAlpha(file) {
  return ALPHA_CAPABLE_SOURCES.test(file.type) || !isJpeg(file);
}

function hasAlpha(canvas) {
  if (canvas.dataset.hasAlpha !== undefined) return canvas.dataset.hasAlpha === 'true';
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) { transparent = true; break; }
  }
  canvas.dataset.hasAlpha = String(transparent);
  return transparent;
}

// ---------------------------------------------------------------------------
// エンコード
// ---------------------------------------------------------------------------

/** 出力形式を決める。auto は「写真は JPEG、透過があれば WebP か PNG」 */
function pickMime(file, options, canvas) {
  if (options.format !== 'auto') {
    return options.format === 'image/webp' && !canEncodeWebp() ? 'image/jpeg' : options.format;
  }
  if (mayHaveAlpha(file) && hasAlpha(canvas)) {
    return canEncodeWebp() ? 'image/webp' : 'image/png';
  }
  return 'image/jpeg';
}

function encode(canvas, mime, quality, flatten) {
  if (flatten) {
    // JPEG は透過を扱えないので、白で塗りつぶしてから重ねる
    const flat = createCanvas(canvas.width, canvas.height);
    const ctx = context(flat);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);
    return toBlob(flat, mime, quality).finally(() => releaseCanvas(flat));
  }
  return toBlob(canvas, mime, quality);
}

function toBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('画像の書き出しに失敗しました'))),
      mime,
      mime === 'image/png' ? undefined : quality,
    );
  });
}

/** 出力が JPEG のときだけ、選び直した Exif を書き戻す */
async function attachExif(blob, mime, options, target, exif) {
  if (options.metadata === 'strip' || mime !== 'image/jpeg' || !exif) return blob;
  const rebuilt = rebuildExif(exif, {
    width: target.width,
    height: target.height,
    keepGps: options.metadata === 'keep-gps',
  });
  if (!rebuilt) return blob;
  return new Blob([insertExif(new Uint8Array(await blob.arrayBuffer()), rebuilt)], { type: mime });
}
