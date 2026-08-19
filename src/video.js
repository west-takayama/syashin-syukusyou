/**
 * 動画の縮小・再エンコード。
 *
 * ブラウザ標準の MediaRecorder で「再生しながら録り直す」方式を使う。
 * 追加のライブラリが要らず端末内で完結する代わりに、
 * 変換には元の動画と同じだけの時間がかかる。
 */

import { fitSize } from './format.js';

/** 保存形式の候補。写真アプリに追加しやすい MP4 (H.264) を優先する */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.4d002a,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

/** 取り込むフレームレート。60fps の動画はここまで落として容量を稼ぐ */
const CAPTURE_FPS = 30;
const AUDIO_BITRATE = 128_000;

let supportedMime;

/** この端末で使える保存形式（無ければ null） */
export function pickVideoMime() {
  if (supportedMime === undefined) {
    supportedMime = typeof MediaRecorder === 'undefined'
      ? null
      : MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? null;
  }
  return supportedMime;
}

/** この端末で動画を変換できるか */
export function canCompressVideo() {
  return Boolean(pickVideoMime())
    && typeof document.createElement('canvas').captureStream === 'function';
}

/**
 * 動画のビットレートを決める。
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
function evenSize({ width, height }) {
  return {
    width: Math.max(2, width - (width % 2)),
    height: Math.max(2, height - (height % 2)),
  };
}

/**
 * 動画を縮小・再エンコードする。
 * @param {File} file
 * @param {import('./compress.js').CompressOptions & {keepAudio: boolean}} options
 * @param {{onProgress?: (ratio: number) => void, signal?: AbortSignal}} [hooks]
 */
export async function compressVideo(file, options, { onProgress, signal } = {}) {
  const mime = pickVideoMime();
  if (!mime) throw new Error('この端末のブラウザは動画の変換に対応していません');

  const { video, url } = await loadVideo(file);
  const cleanup = [];
  try {
    const duration = await readDuration(video);
    const source = { width: video.videoWidth, height: video.videoHeight };
    if (!source.width || !source.height) throw new Error('この動画はブラウザで読み込めませんでした');

    const target = evenSize(fitSize(source.width, source.height, options.maxEdge));
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext('2d', { alpha: false });

    const stream = canvas.captureStream(CAPTURE_FPS);
    cleanup.push(() => stream.getTracks().forEach((track) => track.stop()));

    let audioAttached = false;
    if (options.keepAudio) {
      const audio = await attachAudio(video, stream);
      audioAttached = Boolean(audio);
      if (audio) cleanup.push(() => audio.close().catch(() => {}));
    }
    if (!audioAttached) video.muted = true;

    // 端末の再生制限を先に確かめる。音声付きで始められない場合は無音に切り替える
    try {
      await video.play();
    } catch (error) {
      if (!audioAttached) throw error;
      video.muted = true;
      audioAttached = false;
      for (const track of stream.getAudioTracks()) {
        track.stop();
        stream.removeTrack(track);
      }
      await video.play();
    }
    video.pause();
    video.currentTime = 0;

    const sourceBitrate = duration > 0 ? (file.size * 8) / duration : 0;
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: estimateVideoBitrate(target.width, target.height, options.quality, sourceBitrate),
      ...(audioAttached ? { audioBitsPerSecond: AUDIO_BITRATE } : {}),
    });

    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    const container = mime.split(';')[0];
    const recorded = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: container }));
      recorder.onerror = (event) => reject(event.error ?? new Error('動画の書き出しに失敗しました'));
    });

    recorder.start(1000);
    await video.play();
    drawFrames(video, context, canvas, duration, onProgress, cleanup);
    await waitForEnd(video, signal);

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    await delay(250); // 最後のフレームが取り込まれるのを待つ
    if (recorder.state !== 'inactive') recorder.stop();
    const blob = await recorded;

    if (options.keepLargerOriginal && blob.size >= file.size) {
      return {
        blob: file, name: file.name, mime: file.type || container, kind: 'video',
        width: source.width, height: source.height, sourceWidth: source.width, sourceHeight: source.height,
        duration, audio: audioAttached, skipped: true,
      };
    }
    return {
      blob, name: videoName(file.name, container), mime: container, kind: 'video',
      width: target.width, height: target.height, sourceWidth: source.width, sourceHeight: source.height,
      duration, audio: audioAttached, skipped: false,
    };
  } finally {
    for (const task of cleanup.reverse()) {
      try { task(); } catch { /* 後始末の失敗は無視する */ }
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function videoName(name, mime) {
  const extension = mime === 'video/webm' ? 'webm' : 'mp4';
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}-min.${extension}`;
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('この動画はブラウザで読み込めませんでした'));
    });
    return { video, url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * 長さを読む。
 * WebM などでは長さが未確定 (Infinity) のことがあるため、
 * いったん末尾まで送って確定させる。
 */
async function readDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  return new Promise((resolve) => {
    const done = () => {
      video.ontimeupdate = null;
      video.currentTime = 0;
      resolve(Number.isFinite(video.duration) ? video.duration : 0);
    };
    video.ontimeupdate = done;
    video.currentTime = 1e101;
    setTimeout(done, 2000);
  });
}

/**
 * 解像度・長さと、一覧に出すサムネイルをまとめて読み取る。
 * @param {File} file
 * @param {number} [posterEdge] サムネイルの長辺
 * @returns {Promise<{width: number, height: number, duration: number, poster: ?Blob}>}
 */
export async function readVideoInfo(file, posterEdge = 160) {
  const { video, url } = await loadVideo(file);
  try {
    const duration = await readDuration(video);
    const width = video.videoWidth;
    const height = video.videoHeight;
    return { width, height, duration, poster: await grabPoster(video, duration, posterEdge) };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** 先頭付近の 1 コマを切り出す。取れなければ null */
async function grabPoster(video, duration, maxEdge) {
  if (!video.videoWidth) return null;
  try {
    await new Promise((resolve) => {
      video.onseeked = resolve;
      video.currentTime = duration > 0.2 ? 0.1 : 0;
      setTimeout(resolve, 3000); // シークできない形式でも待ち続けない
    });
    const size = fitSize(video.videoWidth, video.videoHeight, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d').drawImage(video, 0, 0, size.width, size.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7));
  } catch {
    return null;
  } finally {
    video.onseeked = null;
  }
}

// ---------------------------------------------------------------------------
// 変換中の処理
// ---------------------------------------------------------------------------

/** 音声を Web Audio 経由で録画用のストリームに繋ぐ（スピーカーには出さない） */
async function attachAudio(video, stream) {
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    const context = new AudioContextClass();
    if (context.state === 'suspended') await context.resume();
    const destination = context.createMediaStreamDestination();
    context.createMediaElementSource(video).connect(destination);
    const [track] = destination.stream.getAudioTracks();
    if (!track) {
      await context.close();
      return null;
    }
    stream.addTrack(track);
    return context;
  } catch {
    return null; // 音声を取れない端末では映像だけ変換する
  }
}

/** 再生に合わせてフレームを描き続ける */
function drawFrames(video, context, canvas, duration, onProgress, cleanup) {
  let running = true;
  cleanup.push(() => { running = false; });

  const useFrameCallback = typeof video.requestVideoFrameCallback === 'function';
  const draw = () => {
    if (!running) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (onProgress && duration > 0) onProgress(Math.min(1, video.currentTime / duration));
    schedule();
  };
  const schedule = () => {
    if (!running) return;
    if (useFrameCallback) video.requestVideoFrameCallback(draw);
    else requestAnimationFrame(draw);
  };
  schedule();
}

function waitForEnd(video, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      video.onended = null;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      video.onended = null;
      video.pause();
      reject(new DOMException('変換を中止しました', 'AbortError'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    video.onended = finish;
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
