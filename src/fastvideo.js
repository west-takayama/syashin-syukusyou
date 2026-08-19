/**
 * WebCodecs を使った高速な動画変換。
 *
 * MediaRecorder 方式は「等倍で再生しながら録る」ため実時間かかるが、
 * こちらは再生速度を上げてフレームを取り込み、符号化して MP4 に詰め直すので
 * 端末の性能が許すかぎり実時間より速く終わる。
 *
 * 使えない端末や途中で失敗した場合は null を返し、呼び出し側が
 * 従来方式にやり直す。
 */

import { fitSize } from './format.js';
import { Mp4Builder } from './mp4.js';
import { estimateVideoBitrate, evenSize } from './videocommon.js';

const AUDIO_BITRATE = 128_000;
const KEYFRAME_INTERVAL = 2_000_000; // 2 秒ごと（マイクロ秒）
const MAX_QUEUE = 12; // 符号化の待ち行列がこれを超えたら取り込みを控える
const MAX_RATE = 8;
const MIN_RATE = 1;

/**
 * 音声はいったん丸ごと展開するため、大きすぎる動画では高速変換を使わない。
 * （MediaRecorder 方式は少しずつ処理するのでメモリを圧迫しない）
 */
const AUDIO_MAX_BYTES = 300 * 1024 * 1024;
const AUDIO_MAX_SECONDS = 300;

/** 高速変換を見送った理由を残す（実機での切り分け用） */
function bail(reason) {
  console.info(`[写真・動画圧縮] 高速変換を見送りました: ${reason}`);
  return null;
}

export function canUseFastVideo() {
  return typeof window !== 'undefined'
    && typeof window.VideoEncoder === 'function'
    && typeof window.VideoFrame === 'function';
}

/** 端末が対応する映像コーデックを選ぶ。写真アプリと相性の良い H.264 を優先 */
export async function pickFastVideoCodec(width, height, bitrate) {
  const level = width * height > 1920 * 1080 ? '33' : '28'; // 4K は level 5.1、それ以下は 4.0
  // H.264 を最優先（写真アプリと相性が良い）。次点は VP9。
  // AV1 は符号化器から設定 (av1C) を受け取れず MP4 に詰められないため使わない。
  const candidates = [
    `avc1.4200${level}`, `avc1.4d00${level}`, `avc1.6400${level}`,
    'vp09.00.41.08',
  ];
  for (const codec of candidates) {
    const config = {
      codec, width, height, bitrate, framerate: 30,
      latencyMode: 'realtime', // B フレームを避け、並び替えを起こさせない
      ...(codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}),
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch {
      // この端末では使えない指定。次の候補へ
    }
  }
  return null;
}

async function pickAudioCodec(sampleRate, channels) {
  if (typeof window.AudioEncoder !== 'function') return null;
  for (const codec of ['mp4a.40.2', 'opus']) {
    try {
      const support = await AudioEncoder.isConfigSupported({
        codec, sampleRate, numberOfChannels: channels, bitrate: AUDIO_BITRATE,
      });
      if (support.supported) return codec;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

/**
 * 高速変換を試みる。できなければ null を返す。
 * @returns {Promise<?{blob: Blob, width: number, height: number, audio: boolean, speed: number}>}
 */
export async function compressVideoFast(file, options, { video, duration, onProgress, signal } = {}) {
  if (!canUseFastVideo()) return bail('WebCodecs 非対応');
  if (!duration || !video?.videoWidth) return bail('長さまたは解像度が読めない');

  const target = evenSize(fitSize(video.videoWidth, video.videoHeight, options.maxEdge));
  const sourceBitrate = (file.size * 8) / duration;
  const bitrate = estimateVideoBitrate(target.width, target.height, options.quality, sourceBitrate);
  const config = await pickFastVideoCodec(target.width, target.height, bitrate);
  if (!config) return bail('使える映像コーデックがない');

  const wantsAudio = options.keepAudio;
  if (wantsAudio && (file.size > AUDIO_MAX_BYTES || duration > AUDIO_MAX_SECONDS)) {
    // 音声の展開でメモリを使い切る恐れがあるため、従来方式に任せる
    return bail('音声付きで長い／大きい動画');
  }

  const builder = new Mp4Builder();
  let audioAdded = false;
  if (wantsAudio) {
    onProgress?.({ phase: 'audio', ratio: 0 });
    audioAdded = await encodeAudio(file, builder, signal);
    if (audioAdded === null) return bail('音声を扱えない'); // 無音にするより確実な方式に任せる
  }

  const videoTrack = builder.addVideoTrack({
    codec: config.codec,
    width: target.width,
    height: target.height,
  });

  const started = Date.now();
  const captured = await encodeVideo({
    video, duration, target, config, builder, videoTrack, signal,
    onProgress: (ratio, canvas) => onProgress?.({
      phase: 'convert', ratio, canvas,
      speed: (ratio * duration) / Math.max(0.001, (Date.now() - started) / 1000),
    }),
  });
  // H.264 は符号化器から設定 (avcC) を受け取れないと再生できない
  const needsDescription = config.codec.startsWith('avc1');
  if (!captured) return bail('フレームを取り込めなかった');
  if (builder.hasReorderedSamples()) return bail('フレームの順序が入れ替わっている');
  if (needsDescription && !builder.tracks[videoTrack].description) return bail('符号化器の設定を取得できない');

  const blob = builder.finish();
  const speed = duration / Math.max(0.001, (Date.now() - started) / 1000);
  return { blob, width: target.width, height: target.height, audio: audioAdded === true, speed };
}

// ---------------------------------------------------------------------------
// 映像
// ---------------------------------------------------------------------------

/**
 * 再生速度を上げながらフレームを取り込み、符号化して MP4 に足していく。
 * 取り込みが追いつかない場合は再生速度を落とす。
 */
async function encodeVideo({ video, duration, target, config, builder, videoTrack, signal, onProgress }) {
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext('2d', { alpha: false });

  let failed = null;
  let firstChunk = true;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (firstChunk) {
        firstChunk = false;
        const description = metadata?.decoderConfig?.description;
        if (description) builder.tracks[videoTrack].description = new Uint8Array(description);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      builder.addSample(videoTrack, {
        data,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? 0,
        keyFrame: chunk.type === 'key',
      });
    },
    error: (error) => { failed = error; },
  });
  encoder.configure(config);

  const state = {
    rate: target.width * target.height > 1920 * 1080 ? 2 : 4,
    frames: 0, dropped: 0, skipped: 0, lastMediaTime: -1, lastKey: -Infinity, interval: 1 / 30,
  };
  video.muted = true;
  video.playbackRate = state.rate;

  try {
    await video.play();
    await captureFrames({ video, canvas, context, encoder, duration, state, signal, onProgress });
    await encoder.flush();
  } finally {
    video.pause();
    if (encoder.state !== 'closed') encoder.close();
    canvas.width = 1;
    canvas.height = 1;
  }
  if (failed) throw failed;
  return state.frames > 0 && !firstChunk;
}

function captureFrames({ video, canvas, context, encoder, duration, state, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const useFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      video.onended = null;
      resolve();
    };
    const onAbort = () => {
      finished = true;
      video.onended = null;
      reject(new DOMException('変換を中止しました', 'AbortError'));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    video.onended = finish;

    const handle = (mediaTime) => {
      if (finished) return;
      // 取り込みが追いつかない（フレームが落ちている）なら再生速度を下げる
      if (state.lastMediaTime >= 0) {
        const gap = mediaTime - state.lastMediaTime;
        if (gap > 0 && state.frames < 30) state.interval = Math.min(state.interval, gap);
        if (gap > state.interval * 1.8) {
          state.dropped += Math.round(gap / state.interval) - 1;
          if (state.dropped > state.frames * 0.25 && state.rate > MIN_RATE) {
            state.rate = Math.max(MIN_RATE, state.rate / 2);
            video.playbackRate = state.rate;
            state.dropped = 0;
            state.frames = 0;
          }
        }
      }
      state.lastMediaTime = mediaTime;

      if (encoder.encodeQueueSize >= MAX_QUEUE) {
        // 符号化が追いつかない。取り込みを 1 コマ飛ばし、続くようなら速度を落とす
        state.skipped += 1;
        if (state.skipped >= 8 && state.rate > MIN_RATE) {
          state.rate = Math.max(MIN_RATE, state.rate / 2);
          video.playbackRate = state.rate;
          state.skipped = 0;
        }
      } else {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const timestamp = Math.round(mediaTime * 1_000_000);
        const keyFrame = timestamp - state.lastKey >= KEYFRAME_INTERVAL;
        if (keyFrame) state.lastKey = timestamp;
        const frame = new VideoFrame(canvas, {
          timestamp,
          duration: Math.round(state.interval * 1_000_000),
        });
        encoder.encode(frame, { keyFrame });
        frame.close();
        state.frames += 1;
      }
      if (duration > 0) onProgress?.(Math.min(1, mediaTime / duration), canvas);
      schedule();
    };

    const schedule = () => {
      if (finished) return;
      if (useFrameCallback) {
        video.requestVideoFrameCallback((now, metadata) => handle(metadata.mediaTime));
      } else {
        requestAnimationFrame(() => handle(video.currentTime));
      }
    };
    schedule();
  });
}

// ---------------------------------------------------------------------------
// 音声
// ---------------------------------------------------------------------------

/**
 * 音声を復号して符号化し直し、MP4 に足す。
 * @returns {Promise<boolean|null>} 追加したら true、音声が無ければ false、
 *   扱えない場合は null（従来方式に任せる合図）
 */
async function encodeAudio(file, builder, signal) {
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextClass || typeof window.AudioData !== 'function') {
    return bail('AudioData 非対応');
  }

  let buffer;
  const context = new AudioContextClass();
  try {
    buffer = await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    return false; // 音声トラックが無い、または復号できない
  } finally {
    context.close().catch(() => {});
  }
  if (!buffer || buffer.length === 0) return false;

  const channels = Math.min(2, buffer.numberOfChannels);
  const codec = await pickAudioCodec(buffer.sampleRate, channels);
  if (!codec) return bail('使える音声コーデックがない');

  let track = null;
  let failed = null;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      if (track === null) {
        const description = metadata?.decoderConfig?.description;
        if (!description) { failed = new Error('音声の設定を取得できませんでした'); return; }
        track = builder.addAudioTrack({
          codec, description: new Uint8Array(description),
          sampleRate: buffer.sampleRate, channels, bitrate: AUDIO_BITRATE,
        });
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      builder.addSample(track, {
        data, timestamp: chunk.timestamp, duration: chunk.duration ?? 0, keyFrame: true,
      });
    },
    error: (error) => { failed = error; },
  });
  encoder.configure({ codec, sampleRate: buffer.sampleRate, numberOfChannels: channels, bitrate: AUDIO_BITRATE });

  const blockSize = 4096;
  const planes = Array.from({ length: channels }, (unused, index) => buffer.getChannelData(index));
  for (let offset = 0; offset < buffer.length; offset += blockSize) {
    if (signal?.aborted) throw new DOMException('変換を中止しました', 'AbortError');
    if (failed) break;
    const length = Math.min(blockSize, buffer.length - offset);
    const data = new Float32Array(length * channels);
    for (let channel = 0; channel < channels; channel += 1) {
      data.set(planes[channel].subarray(offset, offset + length), channel * length);
    }
    encoder.encode(new AudioData({
      format: 'f32-planar',
      sampleRate: buffer.sampleRate,
      numberOfFrames: length,
      numberOfChannels: channels,
      timestamp: Math.round((offset / buffer.sampleRate) * 1_000_000),
      data,
    }));
    if (encoder.encodeQueueSize > 32) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await encoder.flush();
  encoder.close();
  if (failed) throw failed;
  return track !== null;
}
