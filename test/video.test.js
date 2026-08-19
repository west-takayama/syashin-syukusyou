import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateVideoBitrate } from '../src/video.js';

test('ビットレートは画質に応じて上がる', () => {
  const low = estimateVideoBitrate(1280, 720, 0.5);
  const high = estimateVideoBitrate(1280, 720, 0.9);
  assert.ok(low < high, `${low} < ${high}`);
  assert.ok(high < 8_000_000, '720p で 8Mbps を超えない');
  assert.ok(low > 500_000, '極端に低くならない');
});

test('解像度が上がればビットレートも上がる', () => {
  assert.ok(
    estimateVideoBitrate(640, 360, 0.8) < estimateVideoBitrate(1920, 1080, 0.8),
    '画素数に比例する',
  );
});

test('元の動画より高いビットレートにはしない', () => {
  const sourceBitrate = 800_000; // 元が 0.8Mbps しかない動画
  const bitrate = estimateVideoBitrate(1920, 1080, 1, sourceBitrate);
  assert.ok(bitrate <= sourceBitrate, `${bitrate} <= ${sourceBitrate}`);
});

test('下限と上限で頭打ちにする', () => {
  assert.equal(estimateVideoBitrate(16, 16, 0.4), 200_000, '小さすぎる場合は下限まで上げる');
  assert.equal(estimateVideoBitrate(7680, 4320, 1, 0), 20_000_000, '大きすぎる場合は上限で止める');
});
