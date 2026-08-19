import assert from 'node:assert/strict';
import test from 'node:test';

import { Mp4Builder } from '../src/mp4.js';
import { avcCodec, demuxMp4, findBox, hevcCodec } from '../src/mp4demux.js';

const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, 4, 0x67, 1, 2, 3, 1, 0, 4, 0x68, 1, 2, 3]);
const ASC = Uint8Array.from([0x12, 0x10]); // AAC-LC 44.1kHz ステレオ

function videoSample(index) {
  return {
    data: Uint8Array.from({ length: 60 + index }, (unused, i) => (index * 31 + i) & 0xff),
    timestamp: Math.round((index * 1_000_000) / 30),
    duration: Math.round(1_000_000 / 30),
    keyFrame: index % 5 === 0,
  };
}

function audioSample(index) {
  return {
    data: Uint8Array.from({ length: 24 }, (unused, i) => (index * 7 + i) & 0xff),
    timestamp: Math.round((index * 1024 * 1_000_000) / 44100),
    duration: Math.round((1024 * 1_000_000) / 44100),
    keyFrame: true,
  };
}

async function buildFile({ withAudio = true, count = 12 } = {}) {
  const builder = new Mp4Builder();
  const video = builder.addVideoTrack({ codec: 'avc1.640028', description: AVCC, width: 1280, height: 720 });
  const audio = withAudio
    ? builder.addAudioTrack({ codec: 'mp4a.40.2', description: ASC, sampleRate: 44100, channels: 2, bitrate: 128000 })
    : null;
  for (let i = 0; i < count; i += 1) {
    builder.addSample(video, videoSample(i));
    if (audio !== null) builder.addSample(audio, audioSample(i));
  }
  return builder.finish();
}

test('自分で組み立てた MP4 を読み解ける', async () => {
  const parsed = await demuxMp4(await buildFile());
  assert.ok(parsed, '読み解けること');
  assert.equal(parsed.video.codec, 'avc1.640028');
  assert.equal(parsed.video.width, 1280);
  assert.equal(parsed.video.height, 720);
  assert.deepEqual(parsed.video.description, AVCC, 'avcC をそのまま取り出せる');
  assert.equal(parsed.video.samples.length, 12);
  assert.ok(Math.abs(parsed.duration - 12 / 30) < 0.02, `長さ ${parsed.duration}`);
});

test('サンプルの中身が元のデータと一致する', async () => {
  const file = await buildFile();
  const parsed = await demuxMp4(file);
  for (const [index, sample] of parsed.video.samples.entries()) {
    const bytes = await parsed.reader.read(sample.offset, sample.size);
    assert.deepEqual(bytes, videoSample(index).data, `${index} 番目の映像サンプル`);
  }
  for (const [index, sample] of parsed.audio.samples.entries()) {
    const bytes = await parsed.reader.read(sample.offset, sample.size);
    assert.deepEqual(bytes, audioSample(index).data, `${index} 番目の音声サンプル`);
  }
});

test('キーフレームと時刻を復元できる', async () => {
  const parsed = await demuxMp4(await buildFile());
  const keys = parsed.video.samples.flatMap((sample, index) => (sample.keyFrame ? [index] : []));
  assert.deepEqual(keys, [0, 5, 10]);

  const { timescale, samples } = parsed.video;
  assert.ok(samples.every((sample, index) => index === 0 || sample.dts > samples[index - 1].dts), '復号順に並ぶ');
  const seconds = samples.map((sample) => sample.cts / timescale);
  assert.ok(Math.abs(seconds[6] - 6 / 30) < 0.01, `7 コマ目の時刻 ${seconds[6]}`);
});

test('音声トラックの情報を取り出せる', async () => {
  const parsed = await demuxMp4(await buildFile());
  assert.equal(parsed.audio.codec, 'mp4a.40.2');
  assert.equal(parsed.audio.channels, 2);
  assert.equal(parsed.audio.sampleRate, 44100);
  assert.deepEqual(parsed.audio.description, ASC, 'AudioSpecificConfig を取り出せる');
  assert.equal(parsed.audio.samples.length, 12);
});

test('音声が無くても読み解ける', async () => {
  const parsed = await demuxMp4(await buildFile({ withAudio: false }));
  assert.ok(parsed);
  assert.equal(parsed.audio, null);
});

test('MP4 でないものは null を返す', async () => {
  assert.equal(await demuxMp4(new Blob([new Uint8Array(64)])), null);
  assert.equal(await demuxMp4(new Blob([new TextEncoder().encode('not a video at all')])), null);
});

test('VP9 の動画も読み解ける（コーデック文字列は 10 進）', async () => {
  const builder = new Mp4Builder();
  const track = builder.addVideoTrack({ codec: 'vp09.00.41.08', width: 1280, height: 720 });
  for (let i = 0; i < 4; i += 1) builder.addSample(track, videoSample(i));
  const parsed = await demuxMp4(builder.finish());
  assert.equal(parsed.video.codec, 'vp09.00.31.08', '解像度に応じたレベルが 10 進で入る');
});

/** tkhd の変換行列を書き換えて、縦向き撮影の動画を再現する */
function patchRotation(bytes, rotation) {
  const moov = findBox(bytes, 0, bytes.length, 'moov');
  const trak = findBox(bytes, moov.body, moov.start + moov.size, 'trak');
  const tkhd = findBox(bytes, trak.body, trak.start + trak.size, 'tkhd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = tkhd.body + 40;
  const one = 0x00010000;
  const values = {
    90: [0, one, 0, -one, 0, 0],
    180: [-one, 0, 0, 0, -one, 0],
    270: [0, -one, 0, one, 0, 0],
  }[rotation];
  values.forEach((value, index) => view.setInt32(at + index * 4, value));
  return bytes;
}

test('縦向き動画の回転情報を読み取れる', async () => {
  for (const rotation of [90, 180, 270]) {
    const bytes = new Uint8Array(await (await buildFile()).arrayBuffer());
    const parsed = await demuxMp4(new Blob([patchRotation(bytes, rotation)]));
    assert.equal(parsed.video.rotation, rotation, `${rotation} 度`);
  }
});

test('回転していない動画は 0 度', async () => {
  const parsed = await demuxMp4(await buildFile());
  assert.equal(parsed.video.rotation, 0);
});

test('コーデック文字列を組み立てられる', () => {
  assert.equal(avcCodec(AVCC), 'avc1.640028');
  // HEVC Main profile, level 3.1 の設定例
  const hvcC = new Uint8Array(23);
  hvcC.set([1, 0x01, 0x60, 0x00, 0x00, 0x00], 0); // version, profile_space/tier/idc, 互換フラグ
  hvcC[12] = 93; // level 3.1
  assert.equal(hevcCodec(hvcC, 'hvc1'), 'hvc1.1.6.L93');
});
