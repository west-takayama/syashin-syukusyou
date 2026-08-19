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
import { demuxMp4 } from './mp4demux.js';
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
    const base = {
      codec, width, height, bitrate, framerate: 30,
      latencyMode: 'realtime', // B フレームを避け、並び替えを起こさせない
      ...(codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}),
    };
    // ハードウェア符号化器が使えるならそちらを優先する（速度が桁違いに変わる）
    for (const acceleration of ['prefer-hardware', 'no-preference']) {
      const config = { ...base, hardwareAcceleration: acceleration };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return config;
      } catch {
        // この端末では使えない指定。次の候補へ
      }
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

// ---------------------------------------------------------------------------
// 復号器に直接流し込む方式（最速）
// ---------------------------------------------------------------------------

const DECODE_QUEUE_LIMIT = 8;
const ENCODE_QUEUE_LIMIT = 8;

/**
 * MP4 / MOV を読み解いて、符号化済みのデータを復号器へ直接流し込む。
 * 再生を経由しないので、端末の復号・符号化の速さがそのまま出る。
 * @returns {Promise<?object>}
 */
export async function transcodeDirect(file, options, { onProgress, signal } = {}) {
  if (!canUseFastVideo()) return bail('WebCodecs 非対応');
  onProgress?.({ phase: 'prepare', ratio: 0 });
  const parsed = await demuxMp4(file).catch(() => null);
  if (!parsed) return bail('MP4 として読み解けない');

  const { video, audio, duration, reader } = parsed;
  if (!duration || !video.width || !video.height) return bail('長さまたは解像度が読めない');

  const decoderConfig = await resolveDecoderConfig({
    codec: video.codec,
    codedWidth: video.width,
    codedHeight: video.height,
    ...(video.description ? { description: video.description } : {}),
  });
  if (!decoderConfig) return bail(`復号できない形式 (${video.codec})`);

  // 縦向き動画は画素が横向きのまま入っているので、表示上の向きに直してから縮小する
  const rotation = video.rotation ?? 0;
  const upright = rotation === 90 || rotation === 270
    ? { width: video.height, height: video.width }
    : { width: video.width, height: video.height };
  const target = evenSize(fitSize(upright.width, upright.height, options.maxEdge));
  const sourceBitrate = (file.size * 8) / duration;
  const encoderConfig = await pickFastVideoCodec(
    target.width, target.height,
    estimateVideoBitrate(target.width, target.height, options.quality, sourceBitrate),
  );
  if (!encoderConfig) return bail('使える映像コーデックがない');

  const builder = new Mp4Builder();
  const videoTrack = builder.addVideoTrack({
    codec: encoderConfig.codec, width: target.width, height: target.height,
  });

  // 音声は再符号化せず、そのまま移し替える（速く、音質も落ちない）
  const keepAudio = options.keepAudio && Boolean(audio);
  const audioTrack = keepAudio ? builder.addAudioTrack({
    codec: audio.codec,
    description: audio.description ?? new Uint8Array(0),
    descriptionKind: audio.format === 'Opus' ? 'dOps' : 'AudioSpecificConfig',
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    bitrate: 128_000,
    timescale: audio.timescale,
  }) : null;

  const started = Date.now();
  const ok = await runDirectTranscode({
    reader, video, audio: keepAudio ? audio : null, duration, target, rotation,
    decoderConfig, encoderConfig, builder, videoTrack, audioTrack, signal, onProgress, started,
  });
  if (!ok) return bail('復号または符号化に失敗した');
  if (builder.hasReorderedSamples()) return bail('フレームの順序が入れ替わっている');
  if (encoderConfig.codec.startsWith('avc1') && !builder.tracks[videoTrack].description) {
    return bail('符号化器の設定を取得できない');
  }

  return {
    blob: builder.finish(),
    width: target.width,
    height: target.height,
    sourceWidth: upright.width,
    sourceHeight: upright.height,
    duration,
    audio: keepAudio,
    speed: duration / Math.max(0.001, (Date.now() - started) / 1000),
  };
}

/** この端末で使える復号器の設定を返す。無ければ null */
async function resolveDecoderConfig(base) {
  // ハードウェア復号を優先しつつ、駄目なら指定なしで試す
  for (const acceleration of ['prefer-hardware', 'no-preference']) {
    const config = { ...base, hardwareAcceleration: acceleration };
    try {
      const support = await VideoDecoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch {
      // 次の指定で試す
    }
  }
  return null;
}

/** 復号 → 縮小 → 符号化 を、待ち行列が溢れないように回す */
async function runDirectTranscode({
  reader, video, audio, duration, target, rotation, decoderConfig, encoderConfig,
  builder, videoTrack, audioTrack, signal, onProgress, started,
}) {
  // 回転が必要なとき、または縮小するときは Canvas を経由する
  const needsCanvas = rotation !== 0
    || target.width !== video.width || target.height !== video.height;
  const canvas = needsCanvas ? document.createElement('canvas') : null;
  if (canvas) {
    canvas.width = target.width;
    canvas.height = target.height;
  }
  const context = canvas?.getContext('2d', { alpha: false });
  if (context && rotation !== 0) {
    // 中心を軸に回してから描くよう、あらかじめ座標系を移しておく
    context.translate(target.width / 2, target.height / 2);
    context.rotate((rotation * Math.PI) / 180);
  }
  const swap = rotation === 90 || rotation === 270;
  const drawWidth = swap ? target.height : target.width;
  const drawHeight = swap ? target.width : target.height;
  const frameDuration = Math.round(1_000_000 / 30);

  let failure = null;
  let firstChunk = true;
  let lastKey = -Infinity;

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
        data, timestamp: chunk.timestamp, duration: chunk.duration ?? frameDuration,
        keyFrame: chunk.type === 'key',
      });
    },
    error: (error) => { failure = error; },
  });
  encoder.configure(encoderConfig);

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        if (failure) return;
        const keyFrame = frame.timestamp - lastKey >= KEYFRAME_INTERVAL;
        if (keyFrame) lastKey = frame.timestamp;
        if (needsCanvas) {
          if (rotation === 0) context.drawImage(frame, 0, 0, drawWidth, drawHeight);
          else context.drawImage(frame, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
          const scaled = new VideoFrame(canvas, {
            timestamp: frame.timestamp,
            duration: frame.duration ?? frameDuration,
          });
          encoder.encode(scaled, { keyFrame });
          scaled.close();
        } else {
          encoder.encode(frame, { keyFrame });
        }
      } catch (error) {
        failure = error;
      } finally {
        frame.close();
      }
    },
    error: (error) => { failure = error; },
  });
  decoder.configure(decoderConfig);

  // 映像と音声を、ファイル上の並び順にまとめて読む（読み込みの無駄が少ない）
  const queue = [
    ...video.samples.map((sample) => ({ sample, kind: 'video' })),
    ...(audio ? audio.samples.map((sample) => ({ sample, kind: 'audio' })) : []),
  ].sort((a, b) => a.sample.offset - b.sample.offset);

  try {
    let done = 0;
    for (const { sample, kind } of queue) {
      if (signal?.aborted) throw new DOMException('変換を中止しました', 'AbortError');
      if (failure) break;
      const data = await reader.read(sample.offset, sample.size);
      if (kind === 'audio') {
        builder.addSample(audioTrack, {
          data: data.slice(),
          timestamp: Math.round((sample.cts / audio.timescale) * 1_000_000),
          duration: Math.round((sample.duration / audio.timescale) * 1_000_000),
          keyFrame: true,
        });
        continue;
      }
      decoder.decode(new EncodedVideoChunk({
        type: sample.keyFrame ? 'key' : 'delta',
        timestamp: Math.round((sample.cts / video.timescale) * 1_000_000),
        duration: Math.round((sample.duration / video.timescale) * 1_000_000),
        data,
      }));
      done += 1;
      if (done % 4 === 0) {
        const ratio = done / video.samples.length;
        onProgress?.({
          phase: 'convert', ratio,
          speed: (ratio * duration) / Math.max(0.001, (Date.now() - started) / 1000),
        });
      }
      await waitForQueues(decoder, encoder);
    }
    if (failure) throw failure;
    await decoder.flush();
    await encoder.flush();
    return !failure && !firstChunk;
  } finally {
    if (decoder.state !== 'closed') decoder.close();
    if (encoder.state !== 'closed') encoder.close();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

/**
 * 待ち行列が空くまで待つ（メモリの使い過ぎを防ぐ）。
 * 処理が 1 つ終わった時点ですぐ再開できるよう、時間ではなく通知で待つ。
 */
function waitForDequeue(codec) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { codec.ondequeue = null; } catch { /* 未対応なら何もしない */ }
      resolve();
    };
    const timer = setTimeout(finish, 4); // ondequeue が無い端末向けの保険
    try {
      codec.ondequeue = finish;
    } catch {
      // 未対応。時間で待つ
    }
  });
}

async function waitForQueues(decoder, encoder) {
  while (decoder.decodeQueueSize > DECODE_QUEUE_LIMIT || encoder.encodeQueueSize > ENCODE_QUEUE_LIMIT) {
    await waitForDequeue(decoder.decodeQueueSize > DECODE_QUEUE_LIMIT ? decoder : encoder);
  }
}

// ---------------------------------------------------------------------------
// 再生しながら取り込む方式
// ---------------------------------------------------------------------------

/**
 * 再生しながら取り込む方式（MP4 として読み解けない動画向け）。
 * @returns {Promise<?object>}
 */
export async function transcodeWithPlayback(file, options, { video, duration, onProgress, signal } = {}) {
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
  return {
    blob,
    width: target.width,
    height: target.height,
    sourceWidth: video.videoWidth,
    sourceHeight: video.videoHeight,
    duration,
    audio: audioAdded === true,
    speed: duration / Math.max(0.001, (Date.now() - started) / 1000),
  };
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
