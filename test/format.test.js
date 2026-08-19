import assert from 'node:assert/strict';
import test from 'node:test';

import { fitSize, formatApprox, formatBytes, formatDuration, formatRemaining, outputName, savingPercent } from '../src/format.js';

test('バイト数を読みやすい単位にする', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1000), '1.0 KB');
  assert.equal(formatBytes(4200), '4.2 KB');
  assert.equal(formatBytes(45_000), '45 KB');
  assert.equal(formatBytes(1_234_567), '1.2 MB');
  assert.equal(formatBytes(3_000_000_000), '3.0 GB');
  assert.equal(formatBytes(Number.NaN), '-');
});

test('削減率を求める', () => {
  assert.equal(savingPercent(1000, 250), 75);
  assert.equal(savingPercent(1000, 1000), 0, '同じなら 0%');
  assert.equal(savingPercent(1000, 1200), 0, '増えた場合も 0% とする');
  assert.equal(savingPercent(0, 0), 0);
});

test('出力ファイル名は拡張子を出力形式に合わせる', () => {
  assert.equal(outputName('IMG_0001.HEIC', 'image/jpeg'), 'IMG_0001-min.jpg');
  assert.equal(outputName('写真.png', 'image/webp'), '写真-min.webp');
  assert.equal(outputName('スクショ.png', 'image/png'), 'スクショ-min.png');
  assert.equal(outputName('拡張子なし', 'image/jpeg'), '拡張子なし-min.jpg');
  assert.equal(outputName('a.b.c.jpg', 'image/jpeg', '_small'), 'a.b.c_small.jpg');
});

test('動画の出力名は形式に合わせた拡張子になる', () => {
  assert.equal(outputName('IMG_0002.MOV', 'video/mp4;codecs=avc1.4d002a,mp4a.40.2'), 'IMG_0002-min.mp4');
  assert.equal(outputName('録画.mp4', 'video/webm'), '録画-min.webm');
});

test('再生時間を読みやすく表す', () => {
  assert.equal(formatDuration(9), '0:09');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '-');
});

test('所要時間をざっくり日本語で表す', () => {
  assert.equal(formatApprox(4), '4 秒');
  assert.equal(formatApprox(95), '1 分 35 秒');
  assert.equal(formatApprox(120), '2 分');
  assert.equal(formatRemaining(20), '残り約 20 秒');
  assert.equal(formatRemaining(95), '残り約 1 分 35 秒');
  assert.equal(formatRemaining(0), 'まもなく完了');
});

test('長辺に合わせて縮小する（拡大はしない）', () => {
  assert.deepEqual(fitSize(4032, 3024, 1920), { width: 1920, height: 1440 });
  assert.deepEqual(fitSize(3024, 4032, 1920), { width: 1440, height: 1920 }, '縦位置でも長辺で揃える');
  assert.deepEqual(fitSize(800, 600, 1920), { width: 800, height: 600 }, '小さい画像は拡大しない');
  assert.deepEqual(fitSize(4032, 3024, 0), { width: 4032, height: 3024 }, '0 なら等倍');
  assert.deepEqual(fitSize(10_000, 20, 1000), { width: 1000, height: 2 }, '極端な比率でも 1px 以上を保つ');
});
