import assert from 'node:assert/strict';
import test from 'node:test';

import { extractExif, insertExif, parseExif, readOrientation, rebuildExif } from '../src/exif.js';
import { buildExif, buildJpeg } from './helpers/exif-builder.js';

const SAMPLE = {
  ifd0: [
    { tag: 0x010f, type: 2, values: 'TestCam' }, // Make
    { tag: 0x0110, type: 2, values: 'Model X' }, // Model
    { tag: 0x0112, type: 3, values: [6] }, // Orientation（右に 90 度）
    { tag: 0x0132, type: 2, values: '2024:05:06 07:08:09' }, // DateTime
    { tag: 0x9c9b, type: 1, values: [1, 2, 3, 4, 5] }, // XPTitle（許可リスト外）
  ],
  exifIfd: [
    { tag: 0x829a, type: 5, values: [[1, 250]] }, // ExposureTime
    { tag: 0x8827, type: 3, values: [400] }, // ISO
    { tag: 0x9003, type: 2, values: '2024:05:06 07:08:09' }, // DateTimeOriginal
    { tag: 0xa002, type: 4, values: [4032] }, // PixelXDimension
    { tag: 0xa003, type: 4, values: [3024] }, // PixelYDimension
    { tag: 0xa434, type: 2, values: 'Test 24mm f/1.8' }, // LensModel
  ],
  gpsIfd: [
    { tag: 0x0001, type: 2, values: 'N' },
    { tag: 0x0002, type: 5, values: [[35, 1], [40, 1], [12345, 1000]] },
  ],
};

/** 組み立て直した Exif を、タグ → 値 の対応表にして取り出す */
function tagsOf(exif) {
  const parsed = parseExif(exif);
  const toMap = (entries) => new Map(entries.map((entry) => [entry.tag, entry.values]));
  return { ifd0: toMap(parsed.ifd0), exifIfd: toMap(parsed.exifIfd), gpsIfd: toMap(parsed.gpsIfd) };
}

const text = (values) => new TextDecoder().decode(Uint8Array.from(values)).replace(/\0+$/, '');

for (const little of [false, true]) {
  const label = little ? 'リトルエンディアン' : 'ビッグエンディアン';

  test(`${label}: Orientation を読める`, () => {
    assert.equal(readOrientation(buildExif({ ...SAMPLE, little })), 6);
  });

  test(`${label}: 撮影情報は残し、位置情報は落とす`, () => {
    const rebuilt = rebuildExif(buildExif({ ...SAMPLE, little }), { width: 1920, height: 1440 });
    const { ifd0, exifIfd, gpsIfd } = tagsOf(rebuilt);

    assert.equal(text(ifd0.get(0x010f)), 'TestCam');
    assert.equal(text(ifd0.get(0x0110)), 'Model X');
    assert.equal(text(ifd0.get(0x0132)), '2024:05:06 07:08:09');
    assert.equal(text(exifIfd.get(0x9003)), '2024:05:06 07:08:09');
    assert.equal(text(exifIfd.get(0xa434)), 'Test 24mm f/1.8');
    assert.deepEqual(exifIfd.get(0x829a), [1, 250]); // RATIONAL は分子・分母のまま
    assert.deepEqual(exifIfd.get(0x8827), [400]);

    assert.equal(gpsIfd.size, 0, 'GPS は既定で削除される');
    assert.equal(ifd0.has(0x9c9b), false, '許可リストにないタグは削除される');
  });

  test(`${label}: Orientation は 1 に、画素数は出力サイズに揃える`, () => {
    const rebuilt = rebuildExif(buildExif({ ...SAMPLE, little }), { width: 1920, height: 1440 });
    const { ifd0, exifIfd } = tagsOf(rebuilt);
    assert.deepEqual(ifd0.get(0x0112), [1], '回転はピクセルに焼き込むので Orientation は 1');
    assert.deepEqual(exifIfd.get(0xa002), [1920]);
    assert.deepEqual(exifIfd.get(0xa003), [1440]);
    assert.equal(readOrientation(rebuilt), 1);
  });

  test(`${label}: keepGps を指定すれば位置情報を引き継ぐ`, () => {
    const rebuilt = rebuildExif(buildExif({ ...SAMPLE, little }), { width: 100, height: 100, keepGps: true });
    const { gpsIfd } = tagsOf(rebuilt);
    assert.equal(text(gpsIfd.get(0x0001)), 'N');
    assert.deepEqual(gpsIfd.get(0x0002), [35, 1, 40, 1, 12345, 1000]);
  });
}

test('JPEG から Exif を取り出せる', () => {
  const exif = buildExif(SAMPLE);
  const jpeg = buildJpeg(exif);
  assert.deepEqual(extractExif(jpeg), exif);
});

test('Exif の無い JPEG では null を返す', () => {
  assert.equal(extractExif(buildJpeg(null)), null);
  assert.equal(readOrientation(null), 1);
  assert.equal(rebuildExif(null), null);
});

test('壊れたデータでも例外を投げない', () => {
  assert.equal(readOrientation(new Uint8Array([1, 2, 3])), 1);
  assert.equal(rebuildExif(new Uint8Array(64)), null);
  assert.equal(extractExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])), null);
});

test('Exif を差し込むと APP1 が先頭に来て、残りのセグメントは保たれる', () => {
  const exif = rebuildExif(buildExif(SAMPLE), { width: 800, height: 600 });
  const jpeg = insertExif(buildJpeg(null), exif);

  assert.deepEqual([...jpeg.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe1]);
  assert.equal((jpeg[4] << 8) | jpeg[5], exif.length + 2, 'APP1 の長さフィールド');
  assert.deepEqual(extractExif(jpeg), exif);
  assert.ok(jpeg.includes(0xda), 'SOS 以降のデータが残っている');
  assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9]);
});

test('既に Exif がある JPEG では置き換える', () => {
  const original = buildJpeg(buildExif(SAMPLE));
  const replacement = rebuildExif(buildExif(SAMPLE), { width: 640, height: 480 });
  const jpeg = insertExif(original, replacement);

  assert.deepEqual(extractExif(jpeg), replacement);
  const app1Count = countApp1(jpeg);
  assert.equal(app1Count, 1, 'APP1 が二重にならない');
});

function countApp1(jpeg) {
  let count = 0;
  let offset = 2;
  while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
    const marker = jpeg[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xe1) count += 1;
    offset += 2 + ((jpeg[offset + 2] << 8) | jpeg[offset + 3]);
  }
  return count;
}

test('Exif が大きすぎて APP1 に収まらないときは元の JPEG を返す', () => {
  const jpeg = buildJpeg(null);
  const huge = new Uint8Array(70000);
  huge.set(new TextEncoder().encode('Exif\0\0'), 0);
  assert.deepEqual(insertExif(jpeg, huge), jpeg);
});
