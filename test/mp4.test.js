import assert from 'node:assert/strict';
import test from 'node:test';

import { Mp4Builder } from '../src/mp4.js';

/**
 * 出力を独立に読み解くための最小限のパーサー。
 * 入れ子の箱が始まる位置（サンプルエントリは固定長の見出しの後ろ）を持つ。
 */
const CHILD_OFFSET = {
  moov: 0, trak: 0, mdia: 0, minf: 0, stbl: 0, dinf: 0,
  stsd: 8, // version/flags + エントリ数
  avc1: 78, vp09: 78, av01: 78, // VisualSampleEntry
  mp4a: 28, Opus: 28, // AudioSampleEntry
};

function parseBoxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    assert.ok(size >= 8 && offset + size <= end, `${type} の長さが不正 (${size})`);
    boxes.push({ type, start: offset, size, payload: bytes.subarray(offset + 8, offset + size) });
    offset += size;
  }
  assert.equal(offset, end, '箱の長さの合計がファイル全体と一致する');
  return boxes;
}

/** "moov/trak/mdia" のようなパスで、該当する箱をすべて取り出す */
function findAll(bytes, path, start = 0, end = bytes.length) {
  const [head, ...rest] = path.split('/');
  const matches = parseBoxes(bytes, start, end).filter((box) => box.type === head);
  if (rest.length === 0) return matches;
  return matches.flatMap((match) => findAll(
    bytes, rest.join('/'),
    match.start + 8 + (CHILD_OFFSET[head] ?? 0),
    match.start + match.size,
  ));
}

function findBox(bytes, path, start = 0, end = bytes.length) {
  return findAll(bytes, path, start, end)[0] ?? null;
}

function readTable(box, entrySize, offset = 4) {
  const view = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
  const count = view.getUint32(offset);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = offset + 4 + i * entrySize;
    entries.push(entrySize === 4 ? view.getUint32(at) : [view.getUint32(at), view.getUint32(at + 4)]);
  }
  return entries;
}

const FAKE_AVCC = Uint8Array.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 1, 2, 3, 1, 0, 4, 0x68, 1, 2, 3]);
const FAKE_ASC = Uint8Array.from([0x12, 0x10]); // AAC LC, 44.1kHz, stereo

function sample(index, size, { keyFrame = false, fps = 30 } = {}) {
  return {
    data: Uint8Array.from({ length: size }, () => (index * 7 + 1) & 0xff),
    timestamp: Math.round((index * 1_000_000) / fps),
    duration: Math.round(1_000_000 / fps),
    keyFrame,
  };
}

async function buildVideo(count = 5) {
  const builder = new Mp4Builder();
  const track = builder.addVideoTrack({ codec: 'avc1.640028', description: FAKE_AVCC, width: 640, height: 360 });
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const size = 100 + i * 10;
    sizes.push(size);
    builder.addSample(track, sample(i, size, { keyFrame: i % 3 === 0 }));
  }
  const blob = builder.finish();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), sizes, blob };
}

test('MP4 の全体構造が組み立てられる', async () => {
  const { bytes, blob } = await buildVideo();
  assert.equal(blob.type, 'video/mp4');
  const boxes = parseBoxes(bytes);
  assert.deepEqual(boxes.map((box) => box.type), ['ftyp', 'mdat', 'moov']);
  assert.equal(String.fromCharCode(...boxes[0].payload.subarray(0, 4)), 'isom', '主ブランド');
});

test('サンプル表がデータの位置と長さを正しく指す', async () => {
  const { bytes, sizes } = await buildVideo();
  const stsz = findBox(bytes, 'moov/trak/mdia/minf/stbl/stsz');
  const stco = findBox(bytes, 'moov/trak/mdia/minf/stbl/stco');
  const view = new DataView(stsz.payload.buffer, stsz.payload.byteOffset, stsz.payload.byteLength);
  assert.equal(view.getUint32(4), 0, 'sample_size は 0（個別指定）');
  assert.deepEqual(readTable(stsz, 4, 8), sizes);

  // stco が指す位置に、入れたデータがそのまま入っている
  const offsets = readTable(stco, 4);
  assert.equal(offsets.length, sizes.length);
  offsets.forEach((offset, index) => {
    const expected = sample(index, sizes[index]).data;
    assert.deepEqual(bytes.subarray(offset, offset + sizes[index]), expected, `${index} 番目のサンプル`);
  });
});

test('再生時間の刻みとキーフレームの一覧を書き出す', async () => {
  const { bytes } = await buildVideo(5);
  const stts = readTable(findBox(bytes, 'moov/trak/mdia/minf/stbl/stts'), 8);
  const frames = stts.reduce((sum, [count]) => sum + count, 0);
  const total = stts.reduce((sum, [count, delta]) => sum + count * delta, 0);
  assert.equal(frames, 5, '全フレーム分の刻みがある');
  assert.equal(Math.round(total / 1000), 167, '5 フレーム分 = 約 0.167 秒（マイクロ秒刻み）');
  assert.ok(stts.every(([, delta]) => Math.abs(delta - 33333) <= 1), '30fps 相当の刻み');

  const stss = readTable(findBox(bytes, 'moov/trak/mdia/minf/stbl/stss'), 4);
  assert.deepEqual(stss, [1, 4], 'キーフレームは 1 始まりの番号で並ぶ');
});

test('同じ刻みが続く部分はまとめて書く', async () => {
  const builder = new Mp4Builder();
  const track = builder.addVideoTrack({ codec: 'avc1.640028', description: FAKE_AVCC, width: 320, height: 240 });
  for (let i = 0; i < 6; i += 1) {
    builder.addSample(track, { data: new Uint8Array(20), timestamp: i * 40_000, duration: 40_000, keyFrame: i === 0 });
  }
  const bytes = new Uint8Array(await builder.finish().arrayBuffer());
  assert.deepEqual(readTable(findBox(bytes, 'moov/trak/mdia/minf/stbl/stts'), 8), [[6, 40_000]]);
});

test('すべてキーフレームなら stss を書かない', async () => {
  const builder = new Mp4Builder();
  const track = builder.addVideoTrack({ codec: 'avc1.640028', description: FAKE_AVCC, width: 320, height: 240 });
  for (let i = 0; i < 3; i += 1) builder.addSample(track, sample(i, 50, { keyFrame: true }));
  const bytes = new Uint8Array(await builder.finish().arrayBuffer());
  assert.equal(findBox(bytes, 'moov/trak/mdia/minf/stbl/stss'), null);
});

test('映像の設定 (avcC) をそのまま埋め込む', async () => {
  const { bytes } = await buildVideo();
  const avc1 = findBox(bytes, 'moov/trak/mdia/minf/stbl/stsd/avc1');
  assert.ok(avc1, 'avc1 のサンプルエントリがある');
  const view = new DataView(avc1.payload.buffer, avc1.payload.byteOffset, avc1.payload.byteLength);
  assert.equal(view.getUint16(24), 640, '幅');
  assert.equal(view.getUint16(26), 360, '高さ');
  const avcC = findBox(bytes, 'moov/trak/mdia/minf/stbl/stsd/avc1/avcC');
  assert.deepEqual(avcC.payload, FAKE_AVCC);
});

test('音声トラック（AAC）を追加できる', async () => {
  const builder = new Mp4Builder();
  const video = builder.addVideoTrack({ codec: 'avc1.640028', description: FAKE_AVCC, width: 320, height: 240 });
  const audio = builder.addAudioTrack({
    codec: 'mp4a.40.2', description: FAKE_ASC, sampleRate: 44100, channels: 2, bitrate: 128000,
  });
  for (let i = 0; i < 4; i += 1) {
    builder.addSample(video, sample(i, 80, { keyFrame: i === 0 }));
    builder.addSample(audio, { data: Uint8Array.from({ length: 30 }, () => 0xaa), timestamp: Math.round(i * 23220), duration: 23220, keyFrame: true });
  }
  const bytes = new Uint8Array(await builder.finish().arrayBuffer());

  assert.equal(findAll(bytes, 'moov/trak').length, 2, '映像と音声の 2 トラック');
  const mp4a = findBox(bytes, 'moov/trak/mdia/minf/stbl/stsd/mp4a');
  assert.ok(mp4a, '音声のサンプルエントリがある');
  const view = new DataView(mp4a.payload.buffer, mp4a.payload.byteOffset, mp4a.payload.byteLength);
  assert.equal(view.getUint16(16), 2, 'チャンネル数');
  assert.equal(view.getUint32(24) >>> 16, 44100, 'サンプリング周波数');

  // esds の記述子（0x03 → 0x04 → 0x05）を辿って AudioSpecificConfig を取り出す
  const esds = findBox(bytes, 'moov/trak/mdia/minf/stbl/stsd/mp4a/esds');
  const payload = esds.payload.subarray(4); // version + flags
  assert.equal(payload[0], 0x03, 'ES_Descriptor');
  const decoderConfig = payload.subarray(2 + 3);
  assert.equal(decoderConfig[0], 0x04, 'DecoderConfigDescriptor');
  assert.equal(decoderConfig[2], 0x40, 'AAC を示す objectTypeIndication');
  const specific = decoderConfig.subarray(2 + 13);
  assert.equal(specific[0], 0x05, 'DecoderSpecificInfo');
  assert.deepEqual(specific.subarray(2, 2 + FAKE_ASC.length), FAKE_ASC);
});

test('タイムスタンプの並び替え（B フレーム）を検出できる', async () => {
  const builder = new Mp4Builder();
  const track = builder.addVideoTrack({ codec: 'avc1.640028', description: FAKE_AVCC, width: 320, height: 240 });
  builder.addSample(track, { data: new Uint8Array(10), timestamp: 0, duration: 33333, keyFrame: true });
  builder.addSample(track, { data: new Uint8Array(10), timestamp: 66666, duration: 33333, keyFrame: false });
  assert.equal(builder.hasReorderedSamples(), false);
  builder.addSample(track, { data: new Uint8Array(10), timestamp: 33333, duration: 33333, keyFrame: false });
  assert.equal(builder.hasReorderedSamples(), true);
});
