/** 画面まわり（ファイル選択・設定・結果表示・保存）の組み立て */

import { canEncodeWebp, compressImage } from './compress.js';
import { formatBytes, savingPercent } from './format.js';
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
  previewCaption: document.getElementById('preview-caption'),
  previewClose: document.getElementById('preview-close'),
};

/** @type {Array<{id:number,file:File,status:string,result:?object,error:?string,signature:?string,previewUrl:?string,el:?HTMLElement}>} */
const items = [];
let nextId = 1;
let runToken = 0;
let running = null;
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
  requestRun();
}

// ---------------------------------------------------------------------------
// ファイルの受け取り
// ---------------------------------------------------------------------------

function addFiles(fileList) {
  const incoming = [...fileList].filter((file) => file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name));
  if (incoming.length === 0) {
    setStatus('画像ファイルが見つかりませんでした。');
    return;
  }
  for (const file of incoming) {
    const item = { id: nextId++, file, status: 'pending', result: null, error: null, signature: null, previewUrl: null, el: null };
    items.push(item);
    renderItem(item);
  }
  el.results.hidden = false;
  requestRun();
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
  const pending = items.filter((item) => item.signature !== signature);
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

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

function renderItem(item) {
  if (!item.el) {
    const fragment = el.itemTemplate.content.cloneNode(true);
    item.el = fragment.querySelector('.item');
    item.el.querySelector('.thumb').addEventListener('click', () => openPreview(item));
    item.el.querySelector('.item-save').addEventListener('click', () => saveItem(item));
    el.items.append(fragment);
  }
  const node = item.el;
  const image = node.querySelector('.thumb img');
  const badge = node.querySelector('.badge');
  const saveButton = node.querySelector('.item-save');

  node.dataset.status = item.status;
  node.querySelector('.item-name').textContent = item.result?.name ?? item.file.name;

  if (item.previewUrl && image.src !== item.previewUrl) image.src = item.previewUrl;

  if (item.status === 'done') {
    const percent = savingPercent(item.file.size, item.result.blob.size);
    node.querySelector('.item-meta').textContent =
      `${formatBytes(item.file.size)} → ${formatBytes(item.result.blob.size)} ・ ${item.result.width}×${item.result.height}`;
    badge.textContent = percent > 0 ? `-${percent}%` : '±0%';
    badge.className = 'badge good';
    saveButton.disabled = false;
  } else if (item.status === 'skipped') {
    node.querySelector('.item-meta').textContent = `${formatBytes(item.file.size)} ・ これ以上は軽くなりません`;
    badge.textContent = 'そのまま';
    badge.className = 'badge neutral';
    saveButton.disabled = false;
  } else if (item.status === 'error') {
    node.querySelector('.item-meta').textContent = item.error ?? '読み込めませんでした';
    badge.textContent = 'エラー';
    badge.className = 'badge error';
    saveButton.disabled = true;
  } else {
    node.querySelector('.item-meta').textContent = `${formatBytes(item.file.size)} ・ 処理中…`;
    badge.textContent = '…';
    badge.className = 'badge';
    saveButton.disabled = true;
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
      ? `${finished.length} 枚で ${formatBytes(before - after)} 節約（${percent}% 削減）`
      : `${finished.length} 枚 ・ すでに十分軽いため変化はありません`;

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
      setStatus('この端末では、この枚数をまとめて共有できません。1 枚ずつ保存してください。');
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
    setStatus(`${targets.length} 枚を ZIP にまとめました。`);
  } catch (error) {
    console.error(error);
    setStatus('ZIP の作成に失敗しました。1 枚ずつ保存してください。');
  } finally {
    el.downloadAll.disabled = false;
  }
}

function clearAll() {
  runToken += 1;
  for (const item of items) setPreviewUrl(item, null);
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
  if (!item.previewUrl || typeof el.preview.showModal !== 'function') return;
  previewItem = item;
  showPreviewView('after');
  el.preview.showModal();
}

function showPreviewView(view) {
  if (!previewItem) return;
  for (const button of el.preview.querySelectorAll('.switch button')) {
    button.classList.toggle('active', button.dataset.view === view);
  }
  if (view === 'before') {
    if (!previewOriginalUrl) previewOriginalUrl = URL.createObjectURL(previewItem.file);
    el.previewImage.src = previewOriginalUrl;
    el.previewCaption.textContent = `元の写真 ・ ${formatBytes(previewItem.file.size)}`;
  } else {
    el.previewImage.src = previewItem.previewUrl;
    const blob = resultBlob(previewItem);
    const size = previewItem.result && !previewItem.result.skipped
      ? `${previewItem.result.width}×${previewItem.result.height} ・ ${formatBytes(blob.size)}`
      : `${formatBytes(blob.size)}（そのまま）`;
    el.previewCaption.textContent = `圧縮後 ・ ${size}`;
  }
}

function closePreview() {
  if (previewOriginalUrl) {
    URL.revokeObjectURL(previewOriginalUrl);
    previewOriginalUrl = null;
  }
  previewItem = null;
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
for (const control of [el.maxEdge, el.quality, el.format, el.metadata, el.keepLarger]) {
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
