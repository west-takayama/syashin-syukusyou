/**
 * 動画の縮小・再エンコード。
 *
 * 2 つの方式を持ち、速い方から順に試す。
 *   1. WebCodecs 方式（src/fastvideo.js）… 再生速度を上げて取り込むので実時間より速い
 *   2. MediaRecorder 方式（この中）……… 等倍で再生しながら録り直す。確実だが実時間かかる
 * どちらも端末内で完結し、追加のライブラリは使わない。
 */

import { canUseFastVideo, transcodeDirect, transcodeWithPlayback } from './fastvideo.js';
import { fitSize } from './format.js';
import { CAPTURE_FPS, estimateVideoBitrate, evenSize } from './videocommon.js';

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

// ビットレートの計算は方式によらず共通
export { estimateVideoBitrate } from './videocommon.js';

/**
 * 動画を縮小・再エンコードする。
 * まず WebCodecs 方式を試し、使えない・失敗した場合は MediaRecorder 方式でやり直す。
 * @param {File} file
 * @param {import('./compress.js').CompressOptions & {keepAudio: boolean}} options
 * @param {{onProgress?: (info: {phase: string, ratio: number, speed?: number}) => void, signal?: AbortSignal}} [hooks]
 */
export async function compressVideo(file, options, { onProgress, signal } = {}) {
  if (!pickVideoMime() && !canUseFastVideo()) {
    throw new Error('この端末のブラウザは動画の変換に対応していません');
  }
  onProgress?.({ phase: 'prepare', ratio: 0 });

  // 1) 復号器に直接流し込む方式（最速）。再生を経由しないので <video> も要らない
  const direct = await tryFast(
    () => transcodeDirect(file, options, { onProgress, signal }),
    file, options, onProgress,
  );
  if (direct) return direct;

  // 2) ここから先は再生が必要になる
  const { video, url } = await loadVideo(file);
  try {
    const duration = await readDuration(video);
    const source = { width: video.videoWidth, height: video.videoHeight };
    if (!source.width || !source.height) throw new Error('この動画はブラウザで読み込めませんでした');

    // 2-1) 再生速度を上げて取り込む方式
    const played = await tryFast(
      () => transcodeWithPlayback(file, options, { video, duration, onProgress, signal }),
      file, options, onProgress,
    );
    if (played) return played;
    await resetVideo(video);

    // 2-2) 等倍で録り直す確実な方式
    onProgress?.({ phase: 'convert', ratio: 0, speed: 1 });
    const recorded = await recordRealtime({ file, video, duration, source, options, onProgress, signal });
    return finishResult(file, options, source, duration, recorded);
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** 一度でも高速変換の出力を確認できたら、以降は確認を省いて時間を稼ぐ */
let outputVerified = false;

/**
 * 高速変換を試し、出力が再生できることを確かめてから採用する。
 * 駄目なら null を返して、呼び出し側が次の方式に進む。
 */
async function tryFast(run, file, options, onProgress) {
  if (!canUseFastVideo()) return null;
  let fast = null;
  try {
    fast = await run();
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    console.warn('高速変換に失敗したため、次の方式でやり直します', error);
    return null;
  }
  if (!fast) return null;

  if (!outputVerified) {
    onProgress?.({ phase: 'verify', ratio: 1, speed: fast.speed });
    if (!await verifyOutput(fast.blob, fast)) {
      console.info('[写真・動画圧縮] 高速変換の出力を確認できませんでした。次の方式でやり直します');
      return null;
    }
    outputVerified = true;
  }
  const source = { width: fast.sourceWidth, height: fast.sourceHeight };
  return finishResult(file, options, source, fast.duration, {
    ...fast, container: 'video/mp4', method: 'webcodecs',
  });
}

/** 元より大きくなった場合は元ファイルを使う */
function finishResult(file, options, source, duration, output) {
  const shared = {
    kind: 'video', sourceWidth: source.width, sourceHeight: source.height,
    duration, audio: output.audio, speed: output.speed, method: output.method,
  };
  if (options.keepLargerOriginal && output.blob.size >= file.size) {
    return {
      ...shared, blob: file, name: file.name, mime: file.type || output.container,
      width: source.width, height: source.height, skipped: true,
    };
  }
  return {
    ...shared, blob: output.blob, name: videoName(file.name, output.container), mime: output.container,
    width: output.width, height: output.height, skipped: false,
  };
}

/** 高速変換の出力が本当に再生できるか確かめる（駄目なら従来方式にやり直す） */
async function verifyOutput(blob, { width, height, duration }) {
  const url = URL.createObjectURL(blob);
  const probe = document.createElement('video');
  probe.preload = 'auto';
  probe.muted = true;
  probe.playsInline = true;
  probe.src = url;
  try {
    await withTimeout(new Promise((resolve, reject) => {
      probe.onloadedmetadata = resolve;
      probe.onerror = () => reject(new Error('再生できません'));
    }), 10_000);
    if (probe.videoWidth !== width || probe.videoHeight !== height) return false;
    if (!Number.isFinite(probe.duration)) return false;
    if (Math.abs(probe.duration - duration) > Math.max(1, duration * 0.15)) return false;

    // 実際に 1 コマ取り出せるか確かめる
    await withTimeout(new Promise((resolve, reject) => {
      probe.onseeked = resolve;
      probe.onerror = () => reject(new Error('再生できません'));
      probe.currentTime = Math.min(0.2, duration / 2);
    }), 10_000);
    return probe.readyState >= 2;
  } catch {
    return false;
  } finally {
    probe.removeAttribute('src');
    probe.load();
    URL.revokeObjectURL(url);
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('時間切れ')), ms)),
  ]);
}

/** 高速変換を試した後、従来方式のために再生位置と設定を戻す */
async function resetVideo(video) {
  video.pause();
  video.playbackRate = 1;
  video.muted = false;
  await seekTo(video, 0);
}

/**
 * MediaRecorder 方式：等倍で再生しながら録り直す。確実だが実時間かかる。
 */
async function recordRealtime({ file, video, duration, source, options, onProgress, signal }) {
  const mime = pickVideoMime();
  if (!mime) throw new Error('この端末のブラウザは動画の変換に対応していません');
  const cleanup = [];
  try {
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

    return {
      blob, container, width: target.width, height: target.height,
      audio: audioAttached, speed: 1, method: 'recorder',
    };
  } finally {
    for (const task of cleanup.reverse()) {
      try { task(); } catch { /* 後始末の失敗は無視する */ }
    }
    video.pause();
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
  video.preload = 'metadata'; // 必要になった時点で読み込ませる
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
 * いったん末尾まで送って確定させてから先頭に戻す。
 */
async function readDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;

  const duration = await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); // 変換中に再生位置を戻してしまわないよう必ず止める
      video.ontimeupdate = null;
      resolve(Number.isFinite(video.duration) ? video.duration : 0);
    };
    video.ontimeupdate = done;
    timer = setTimeout(done, 2000);
    video.currentTime = 1e101; // 末尾まで送ると長さが確定する
  });
  await seekTo(video, 0);
  return duration;
}

/** 指定位置まで移動し、完了を待つ（応答が無い場合も止まらないようにする） */
function seekTo(video, time) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.onseeked = null;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 3000);
    video.onseeked = done;
    try {
      video.currentTime = time;
    } catch {
      done();
    }
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
    await seekTo(video, duration > 0.2 ? 0.1 : 0);
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
    if (duration > 0) {
      onProgress?.({
        phase: 'convert', speed: 1, canvas,
        ratio: Math.min(1, video.currentTime / duration),
      });
    }
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
