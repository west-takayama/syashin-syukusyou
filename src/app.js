/** 画面まわり（ファイル選択・設定・結果表示・保存）の組み立て */

import { canEncodeWebp, compressImage } from './compress.js';
import { formatApprox, formatBytes, formatDuration, formatRemaining, savingPercent } from './format.js';
import { canCompressVideo, compressVideo, readVideoInfo } from './video.js';
import { createZip } from './zip.js';

const SETTINGS_KEY = 'syashin-syukusyou/settings/v1';
const SHARE_CACHE = 'syashin-syukusyou-shared';

/** プリセット（長辺と画質の組み合わせ） */
const PRESETS = {
  light: { maxEdge: 1280, quality: 70 },
  balanced: { maxEdge: 1920, quality: 80 },
  fine: { maxEdge: 2560, quality: 85 },
  keep: { maxEdge: 0, quality: 80 },
};

const el = {
  fileInput: document.getElementById('file-input'),
  dropzone: document.getElementById('dropzone'),
  presets: document.getElementById('presets'),
  advanced: document.getElementById('advanced'),
  maxEdge: document.getElementById('max-edge'),
  quality: document.getElementById('quality'),
  qualityValue: document.getElementById('quality-value'),
  format: document.getElementById('format'),
  metadata: document.getElementById('metadata'),
  keepAudio: document.getElementById('keep-audio'),
  keepLarger: document.getElementById('keep-larger'),
  results: document.getElementById('results'),
  items: document.getElementById('items'),
  itemTemplate: document.getElementById('item-template'),
  summaryBefore: document.getElementById('summary-before'),
  summaryAfter: document.getElementById('summary-after'),
  summarySaving: document.getElementById('summary-saving'),
  progress: document.getElementById('progress'),
  progressBar: document.getElementById('progress-bar'),
  status: document.getElementById('status'),
  shareAll: document.getElementById('share-all'),
  downloadAll: document.getElementById('download-all'),
  clearAll: document.getElementById('clear-all'),
  preview: document.getElementById('preview'),
  previewImage: document.getElementById('preview-image'),
  previewVideo: document.getElementById('preview-video'),
  previewCaption: document.getElementById('preview-caption'),
  previewClose: document.getElementById('preview-close'),
};

/**
 * @typedef {object} Item
 * @property {number} id
 * @property {File} file
 * @property {'image'|'video'} kind
 * @property {'pending'|'ready'|'working'|'done'|'skipped'|'error'} status
 * @property {?object} result
 * @property {?string} error
 * @property {?string} signature 変換時の設定（設定が変わったかの判定に使う）
 * @property {?string} previewUrl 変換後のファイル（プレビュー用）
 * @property {?string} posterUrl 一覧のサムネイル（動画は静止画を作る）
 * @property {?HTMLElement} el
 * @property {number} progress 0〜1（動画の変換中のみ）
 * @property {?string} phase 変換の段階（準備中・変換中など）
 * @property {number} speed 実時間に対する変換の速さ（2 なら 2 倍速）
 * @property {?AbortController} controller
 * @property {?object} info 動画の元情報（長さ・解像度）
 */

/** @type {Item[]} */
const items = [];
let nextId = 1;
let runToken = 0;
let running = null;
let settingsTimer = null;
let previewItem = null;
let previewOriginalUrl = null;

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

function currentOptions() {
  return {
    maxEdge: Number(el.maxEdge.value),
    quality: Number(el.quality.value) / 100,
    format: el.format.value,
    metadata: el.metadata.value,
    keepAudio: el.keepAudio.value === 'keep',
    keepLargerOriginal: el.keepLarger.checked,
  };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      maxEdge: el.maxEdge.value,
      quality: el.quality.value,
      format: el.format.value,
      metadata: el.metadata.value,
      keepAudio: el.keepAudio.value,
      keepLarger: el.keepLarger.checked,
      advancedOpen: el.advanced.open,
    }));
  } catch {
    // プライベートブラウズなどで保存できなくても動作に支障はない
  }
}

function restoreSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  if (saved) {
    if (saved.maxEdge !== undefined) el.maxEdge.value = saved.maxEdge;
    if (saved.quality !== undefined) el.quality.value = saved.quality;
    if (saved.format !== undefined) el.format.value = saved.format;
    if (saved.metadata !== undefined) el.metadata.value = saved.metadata;
    if (saved.keepAudio !== undefined) el.keepAudio.value = saved.keepAudio;
    if (saved.keepLarger !== undefined) el.keepLarger.checked = saved.keepLarger;
    el.advanced.open = Boolean(saved.advancedOpen);
  }
  if (!canEncodeWebp()) {
    const option = el.format.querySelector('option[value="image/webp"]');
    option.disabled = true;
    option.textContent = 'WebP（この端末では非対応）';
    if (el.format.value === 'image/webp') el.format.value = 'auto';
  }
  syncSettingsView();
}

/** スライダーの数値表示とプリセットの選択状態を合わせる */
function syncSettingsView() {
  el.qualityValue.textContent = el.quality.value;
  const maxEdge = Number(el.maxEdge.value);
  const quality = Number(el.quality.value);
  for (const chip of el.presets.querySelectorAll('.chip')) {
    const preset = PRESETS[chip.dataset.preset];
    const active = preset.maxEdge === maxEdge && preset.quality === quality;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  }
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  el.maxEdge.value = String(preset.maxEdge);
  el.quality.value = String(preset.quality);
  onSettingsChanged();
}

function onSettingsChanged() {
  syncSettingsView();
  saveSettings();

  // 設定が変わった時点で、古い結果は保存できないようにしておく
  const signature = signatureOf(currentOptions());
  for (const item of items) {
    if (item.kind === 'video') {
      renderItem(item); // 動画は自動変換せず「もう一度変換」の案内だけ出す
    } else if (item.signature && item.signature !== signature && item.status !== 'working') {
      item.status = 'pending';
      renderItem(item);
    }
  }
  updateSummary();

  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(requestRun, 350); // 続けて操作されたときの無駄打ちを防ぐ
}

// ---------------------------------------------------------------------------
// ファイルの受け取り
// ---------------------------------------------------------------------------

const IMAGE_PATTERN = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;
const VIDEO_PATTERN = /\.(mp4|mov|m4v|webm|avi|mkv|3gp|ogv)$/i;

function isVideoFile(file) {
  return file.type.startsWith('video/') || (!file.type && VIDEO_PATTERN.test(file.name));
}

function isSupportedFile(file) {
  return file.type.startsWith('image/') || isVideoFile(file)
    || IMAGE_PATTERN.test(file.name) || VIDEO_PATTERN.test(file.name);
}

function addFiles(fileList) {
  const incoming = [...fileList].filter(isSupportedFile);
  if (incoming.length === 0) {
    setStatus('写真・動画のファイルが見つかりませんでした。');
    return;
  }
  for (const file of incoming) {
    const video = isVideoFile(file);
    /** @type {Item} */
    const item = {
      id: nextId++, file, kind: video ? 'video' : 'image',
      status: video ? 'ready' : 'pending',
      result: null, error: null, signature: null, previewUrl: null, posterUrl: null, el: null,
      progress: 0, phase: null, speed: 0, controller: null, info: null,
    };
    items.push(item);
    renderItem(item);
    if (video) prepareVideo(item);
  }
  el.results.hidden = false;
  requestRun();
}

let videoInfoQueue = Promise.resolve();

/** 動画の情報読み取りは 1 本ずつ順番に行う（同時デコードで端末が詰まるのを防ぐ） */
function prepareVideo(item) {
  videoInfoQueue = videoInfoQueue.then(() => loadVideoInfo(item)).catch(() => {});
  return videoInfoQueue;
}

/** 動画の長さ・解像度とサムネイルを読み込んでおく */
async function loadVideoInfo(item) {
  if (!canCompressVideo()) {
    item.status = 'error';
    item.error = 'この端末のブラウザは動画の変換に対応していません';
    renderItem(item);
    return;
  }
  try {
    const { poster, width, height, duration } = await readVideoInfo(item.file);
    item.info = { width, height, duration };
    if (poster) setPosterUrl(item, URL.createObjectURL(poster));
  } catch {
    // 情報が読めなくても「変換」は試せるようにしておく
  }
  renderItem(item);
}



// ---------------------------------------------------------------------------
// 圧縮の実行
// ---------------------------------------------------------------------------

/** 設定が変わったかどうかを比べるための文字列 */
function signatureOf(options) {
  return JSON.stringify(options);
}

/** 実行を要求する。処理中に呼ばれた場合は、今の処理を止めてやり直す */
function requestRun() {
  const token = ++runToken;
  const previous = running;
  running = (async () => {
    if (previous) await previous;
    if (token !== runToken) return;
    await processAll(token);
  })().catch((error) => {
    console.error(error);
    setStatus('処理中にエラーが発生しました。');
  });
}

async function processAll(token) {
  const options = currentOptions();
  const signature = signatureOf(options);
  // 動画は時間がかかるので自動では処理せず、「変換」ボタンで明示的に始める
  const pending = items.filter((item) => item.kind === 'image' && item.signature !== signature);
  if (pending.length === 0) {
    updateSummary();
    return;
  }

  for (const item of pending) {
    item.status = 'working';
    item.error = null;
    renderItem(item);
  }
  updateSummary();

  let done = 0;
  for (const item of pending) {
    if (token !== runToken) return;
    setProgress(done, pending.length);
    try {
      const result = await compressImage(item.file, options);
      if (token !== runToken) return;
      setPreviewUrl(item, URL.createObjectURL(result.blob));
      item.result = result;
      item.status = result.skipped ? 'skipped' : 'done';
    } catch (error) {
      if (token !== runToken) return;
      item.result = null;
      item.status = 'error';
      item.error = error instanceof Error ? error.message : String(error);
    }
    item.signature = signature;
    done += 1;
    renderItem(item);
    updateSummary();
    setProgress(done, pending.length);
    await new Promise((resolve) => setTimeout(resolve, 0)); // 画面の更新を挟む
  }
  if (token === runToken) setProgress(0, 0);
}

function setPreviewUrl(item, url) {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  item.previewUrl = url;
}

function setPosterUrl(item, url) {
  if (item.posterUrl) URL.revokeObjectURL(item.posterUrl);
  item.posterUrl = url;
}

/** 一覧に出すサムネイル。動画は静止画のポスターを使う */
function thumbnailUrl(item) {
  return item.kind === 'video' ? item.posterUrl : item.previewUrl;
}

/**
 * 動画を変換する。
 * 再生を伴うため、必ずユーザーの操作（ボタン）から呼び出す。
 * @param {Item} item
 */
async function convertVideo(item) {
  if (item.status === 'working') return;
  const options = currentOptions();
  const signature = signatureOf(options);
  const controller = new AbortController();
  item.controller = controller;
  item.status = 'working';
  item.progress = 0;
  item.phase = 'prepare';
  item.speed = 0;
  item.error = null;
  renderItem(item);
  updateSummary();

  let lastPainted = 0;
  try {
    const result = await compressVideo(item.file, options, {
      signal: controller.signal,
      onProgress: (info) => {
        item.progress = info.ratio ?? item.progress;
        item.phase = info.phase ?? item.phase;
        if (info.speed) item.speed = info.speed;
        // 1 コマごとに描き替えると無駄なので、表示の更新は 0.2 秒おきにする
        const now = Date.now();
        if (now - lastPainted < 200 && info.phase === 'convert') return;
        lastPainted = now;
        renderItemProgress(item, info.canvas);
      },
    });
    setPreviewUrl(item, URL.createObjectURL(result.blob));
    item.result = result;
    item.status = result.skipped ? 'skipped' : 'done';
    item.signature = signature;
  } catch (error) {
    if (error?.name === 'AbortError') {
      item.status = 'ready';
      item.error = null;
    } else {
      item.status = 'error';
      item.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    item.controller = null;
    item.progress = 0;
    item.phase = null;
    renderItem(item);
    updateSummary();
  }
}

function cancelVideo(item) {
  item.controller?.abort();
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

function ensureNode(item) {
  if (!item.el) {
    const fragment = el.itemTemplate.content.cloneNode(true);
    item.el = fragment.querySelector('.item');
    item.el.querySelector('.thumb').addEventListener('click', () => openPreview(item));
    item.el.querySelector('.item-save').addEventListener('click', () => saveItem(item));
    item.el.querySelector('.item-action').addEventListener('click', () => {
      if (item.status === 'working') cancelVideo(item);
      else convertVideo(item);
    });
    el.items.append(fragment);
  }
  return item.el;
}

/** 変換後の内容を一言で表す */
function describeResult(item) {
  const { width, height } = item.result;
  if (item.kind !== 'video') return `${width}×${height}`;
  const duration = item.result.duration ?? item.info?.duration ?? 0;
  return `${width}×${height} ・ ${formatDuration(duration)}${item.result.audio === false ? ' ・ 音声なし' : ''}`;
}

/** 変換前の動画の情報 */
function describeSource(item) {
  const parts = [formatBytes(item.file.size)];
  if (item.info?.width) parts.push(`${item.info.width}×${item.info.height}`);
  if (item.info?.duration) parts.push(formatDuration(item.info.duration));
  return parts.join(' ・ ');
}

/** 変換後に設定が変わっているか */
function isStale(item) {
  return Boolean(item.signature) && item.signature !== signatureOf(currentOptions());
}

function renderItem(item) {
  const node = ensureNode(item);
  const image = node.querySelector('.thumb img');
  const meta = node.querySelector('.item-meta');
  const badge = node.querySelector('.badge');
  const saveButton = node.querySelector('.item-save');
  const actionButton = node.querySelector('.item-action');

  node.dataset.status = item.status;
  node.dataset.kind = item.kind;
  node.querySelector('.item-name').textContent = item.result?.name ?? item.file.name;
  const thumbnail = thumbnailUrl(item);
  if (thumbnail && image.src !== thumbnail) image.src = thumbnail;
  if (item.status !== 'working') node.querySelector('.thumb-live').hidden = true;

  badge.className = 'badge';
  actionButton.hidden = true;
  actionButton.classList.remove('primary');
  saveButton.hidden = false;
  saveButton.disabled = true;

  if (item.status === 'done' || item.status === 'skipped') {
    const size = item.result.blob.size;
    const percent = savingPercent(item.file.size, size);
    meta.textContent = item.status === 'skipped'
      ? `${formatBytes(item.file.size)} ・ これ以上は軽くなりません`
      : `${formatBytes(item.file.size)} → ${formatBytes(size)} ・ ${describeResult(item)}`;
    badge.textContent = item.status === 'skipped' ? 'そのまま' : (percent > 0 ? `-${percent}%` : '±0%');
    badge.className = item.status === 'skipped' ? 'badge neutral' : 'badge good';
    saveButton.disabled = false;
    if (item.kind === 'video' && isStale(item)) {
      meta.textContent += ' ・ 設定が変わりました';
      actionButton.hidden = false;
      actionButton.textContent = 'もう一度変換';
    }
  } else if (item.status === 'error') {
    meta.textContent = item.error ?? '読み込めませんでした';
    badge.textContent = 'エラー';
    badge.className = 'badge error';
    saveButton.hidden = true;
    if (item.kind === 'video' && canCompressVideo()) {
      actionButton.hidden = false;
      actionButton.textContent = 'やり直す';
    }
  } else if (item.status === 'ready') {
    // 動画は「変換」を押したときだけ処理する（長さと同じだけ時間がかかるため）
    meta.textContent = item.info?.duration
      ? `${describeSource(item)} ・ 変換の目安 約 ${formatApprox(item.info.duration)}`
      : describeSource(item);
    badge.textContent = '動画';
    badge.className = 'badge neutral';
    saveButton.hidden = true;
    actionButton.hidden = false;
    actionButton.textContent = '変換';
    actionButton.classList.add('primary');
  } else if (item.status === 'working' && item.kind === 'video') {
    badge.textContent = '…';
    badge.className = 'badge working';
    saveButton.hidden = true;
    actionButton.hidden = false;
    actionButton.textContent = '中止';
  } else {
    meta.textContent = `${formatBytes(item.file.size)} ・ 処理中…`;
    badge.textContent = '…';
  }
  renderItemProgress(item);
}

const PHASE_LABELS = {
  prepare: '準備中…',
  audio: '音声を処理中…',
  verify: '仕上げ中…',
};

/**
 * 動画の変換中の表示を更新する。
 * 進み具合・残り時間・変換の速さに加えて、いま処理しているコマも映して
 * 「止まっていない」ことが分かるようにする。
 */
function renderItemProgress(item, frame) {
  const node = item.el;
  if (!node) return;
  const progress = node.querySelector('.item-progress');
  const live = node.querySelector('.thumb-live');
  const working = item.kind === 'video' && item.status === 'working';
  progress.hidden = !working;
  if (!working) {
    live.hidden = true;
    return;
  }

  const percent = Math.round(item.progress * 100);
  node.querySelector('.item-progress-bar').style.width = `${item.phase === 'convert' ? percent : 100}%`;
  node.querySelector('.badge').textContent = item.phase === 'convert' ? `${percent}%` : '…';

  const duration = item.info?.duration ?? 0;
  const speed = item.speed > 0.1 ? item.speed : 1;
  const parts = [];
  if (item.phase === 'convert') {
    parts.push(`変換中 ${percent}%`);
    if (duration > 0) parts.push(formatRemaining((duration * (1 - item.progress)) / speed));
    if (item.speed >= 1.15) parts.push(`${item.speed.toFixed(1)} 倍速`);
  } else {
    parts.push(PHASE_LABELS[item.phase] ?? '変換中…');
  }
  node.querySelector('.item-meta').textContent = parts.join(' ・ ');

  // いま符号化しているコマをサムネイル代わりに映す
  if (frame && frame.width > 0) {
    live.hidden = false;
    const context = live.getContext('2d');
    context.drawImage(frame, 0, 0, live.width, live.height);
  }
}

function updateSummary() {
  const finished = items.filter((item) => item.status === 'done' || item.status === 'skipped');
  const before = finished.reduce((sum, item) => sum + item.file.size, 0);
  const after = finished.reduce((sum, item) => sum + resultBlob(item).size, 0);
  const percent = savingPercent(before, after);

  el.summaryBefore.textContent = formatBytes(before);
  el.summaryAfter.textContent = formatBytes(after);
  el.summarySaving.textContent = finished.length === 0
    ? ''
    : percent > 0
      ? `${finished.length} 件で ${formatBytes(before - after)} 節約（${percent}% 削減）`
      : `${finished.length} 件 ・ すでに十分軽いため変化はありません`;

  const savable = finished.length > 0;
  el.downloadAll.disabled = !savable;
  el.shareAll.disabled = !savable;
  el.shareAll.hidden = !supportsFileShare();
}

function setProgress(done, total) {
  if (total <= 1) {
    el.progress.hidden = true;
    setStatus(total === 0 ? '' : '処理中…');
    return;
  }
  el.progress.hidden = false;
  el.progressBar.style.width = `${Math.round((done / total) * 100)}%`;
  setStatus(`${done} / ${total} 枚を処理中…`);
}

function setStatus(text) {
  el.status.textContent = text;
}

function resultBlob(item) {
  return item.result ? item.result.blob : item.file;
}

function resultName(item) {
  return item.result ? item.result.name : item.file.name;
}

// ---------------------------------------------------------------------------
// 保存・共有
// ---------------------------------------------------------------------------

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function saveItem(item) {
  if (item.status !== 'done' && item.status !== 'skipped') return;
  download(resultBlob(item), resultName(item));
}

function savableItems() {
  return items.filter((item) => item.status === 'done' || item.status === 'skipped');
}

function shareFiles() {
  return savableItems().map((item) => new File([resultBlob(item)], resultName(item), {
    type: resultBlob(item).type || 'image/jpeg',
  }));
}

let fileShareSupport = null;

/** 画像そのものを共有できる端末か（iOS の「画像を保存」などが使えるか） */
function supportsFileShare() {
  if (fileShareSupport === null) {
    const probe = new File([new Uint8Array(1)], 'probe.jpg', { type: 'image/jpeg' });
    fileShareSupport = Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [probe] }));
  }
  return fileShareSupport;
}

async function shareAll() {
  const files = shareFiles();
  if (files.length === 0) return;
  try {
    if (!navigator.canShare({ files })) {
      setStatus('この端末では、この数をまとめて共有できません。1 件ずつ保存してください。');
      return;
    }
    await navigator.share({ files });
  } catch (error) {
    if (error?.name !== 'AbortError') {
      setStatus('共有できませんでした。「まとめて保存（ZIP）」をお試しください。');
    }
  }
}

async function downloadAll() {
  const targets = savableItems();
  if (targets.length === 0) return;
  if (targets.length === 1) {
    saveItem(targets[0]);
    return;
  }
  el.downloadAll.disabled = true;
  setStatus('ZIP を作成中…');
  try {
    const zip = await createZip(targets.map((item) => ({
      name: resultName(item),
      blob: resultBlob(item),
      lastModified: item.file.lastModified,
    })));
    const stamp = new Date().toISOString().slice(0, 10);
    download(zip, `compressed-photos-${stamp}.zip`);
    setStatus(`${targets.length} 件を ZIP にまとめました。`);
  } catch (error) {
    console.error(error);
    setStatus('ZIP の作成に失敗しました。1 件ずつ保存してください。');
  } finally {
    el.downloadAll.disabled = false;
  }
}

function clearAll() {
  runToken += 1;
  for (const item of items) {
    item.controller?.abort();
    setPreviewUrl(item, null);
    setPosterUrl(item, null);
  }
  items.length = 0;
  el.items.replaceChildren();
  el.results.hidden = true;
  setStatus('');
  setProgress(0, 0);
  el.fileInput.value = '';
  updateSummary();
}

// ---------------------------------------------------------------------------
// 見比べ用のプレビュー
// ---------------------------------------------------------------------------

function openPreview(item) {
  // <dialog> に対応していない古いブラウザでは見比べ機能を使わない
  if (typeof el.preview.showModal !== 'function') return;
  if (item.status === 'working') return;
  // 動画は変換前でも元のファイルを再生して確認できる
  if (!item.previewUrl && item.kind !== 'video') return;
  previewItem = item;
  showPreviewView(item.result ? 'after' : 'before');
  el.preview.showModal();
}

/** 動画は <video>、写真は <img> で表示する */
function showPreviewMedia(url, asVideo) {
  el.previewVideo.hidden = !asVideo;
  el.previewImage.hidden = asVideo;
  if (asVideo) {
    el.previewImage.removeAttribute('src');
    el.previewVideo.src = url;
  } else {
    el.previewVideo.pause();
    el.previewVideo.removeAttribute('src');
    el.previewImage.src = url;
  }
}

function showPreviewView(view) {
  if (!previewItem) return;
  for (const button of el.preview.querySelectorAll('.switch button')) {
    button.classList.toggle('active', button.dataset.view === view);
  }
  const isVideo = previewItem.kind === 'video';
  if (view === 'before') {
    if (!previewOriginalUrl) previewOriginalUrl = URL.createObjectURL(previewItem.file);
    showPreviewMedia(previewOriginalUrl, isVideo);
    el.previewCaption.textContent = `${isVideo ? '元の動画' : '元の写真'} ・ ${formatBytes(previewItem.file.size)}`;
    return;
  }
  if (!previewItem.result) {
    showPreviewView('before');
    return;
  }
  // 変換後は、動画ならその出力を再生し、写真は縮小後の画像を表示する
  showPreviewMedia(previewItem.previewUrl, isVideo && !previewItem.result.skipped);
  const blob = resultBlob(previewItem);
  el.previewCaption.textContent = previewItem.result.skipped
    ? `変換後 ・ ${formatBytes(blob.size)}（そのまま）`
    : `変換後 ・ ${describeResult(previewItem)} ・ ${formatBytes(blob.size)}`;
}

function closePreview() {
  if (previewOriginalUrl) {
    URL.revokeObjectURL(previewOriginalUrl);
    previewOriginalUrl = null;
  }
  previewItem = null;
  el.previewVideo.pause();
  el.previewVideo.removeAttribute('src');
  el.previewImage.removeAttribute('src');
}

// ---------------------------------------------------------------------------
// イベント登録
// ---------------------------------------------------------------------------

el.fileInput.addEventListener('change', () => {
  addFiles(el.fileInput.files);
  el.fileInput.value = ''; // 同じ写真をもう一度選べるようにする
});

el.presets.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (chip) applyPreset(chip.dataset.preset);
});

el.quality.addEventListener('input', () => {
  el.qualityValue.textContent = el.quality.value;
});
for (const control of [el.maxEdge, el.quality, el.format, el.metadata, el.keepAudio, el.keepLarger]) {
  control.addEventListener('change', onSettingsChanged);
}
el.advanced.addEventListener('toggle', saveSettings);

el.downloadAll.addEventListener('click', downloadAll);
el.shareAll.addEventListener('click', shareAll);
el.clearAll.addEventListener('click', clearAll);

el.preview.addEventListener('click', (event) => {
  const button = event.target.closest('.switch button');
  if (button) showPreviewView(button.dataset.view);
});
el.previewClose.addEventListener('click', () => el.preview.close());
el.preview.addEventListener('close', closePreview);

for (const type of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'dragend', 'drop']) {
  el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('dragging'));
}
el.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
window.addEventListener('paste', (event) => {
  if (event.clipboardData?.files?.length) addFiles(event.clipboardData.files);
});

/**
 * 他アプリから「共有」で送られてきた写真を受け取る。
 * Service Worker が Cache Storage に置いたものを読み出して取り込む。
 */
async function loadSharedPhotos() {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open(SHARE_CACHE);
    const files = [];
    for (const key of await cache.keys()) {
      const response = await cache.match(key);
      if (!response) continue;
      const blob = await response.blob();
      const name = new URL(key.url).searchParams.get('name') || `photo-${files.length + 1}.jpg`;
      files.push(new File([blob], name, { type: blob.type }));
    }
    await caches.delete(SHARE_CACHE);
    if (files.length > 0) addFiles(files);
  } catch {
    // 受け取れなくても、通常どおり写真を選んで使える
  }
}

restoreSettings();
updateSummary();
loadSharedPhotos();

// オフラインでも使えるようにキャッシュしておく
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
