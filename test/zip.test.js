import assert from 'node:assert/strict';
import test from 'node:test';

import { createZip, crc32, uniqueNames } from '../src/zip.js';

test('CRC-32 が既知の値と一致する', () => {
  assert.equal(crc32(new TextEncoder().encode('')), 0x00000000);
  assert.equal(crc32(new TextEncoder().encode('hello world')), 0x0d4a1185);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('同名のファイルには連番を付ける', () => {
  assert.deepEqual(
    uniqueNames(['a.jpg', 'a.jpg', 'b.jpg', 'a.jpg']),
    ['a.jpg', 'a (2).jpg', 'b.jpg', 'a (3).jpg'],
  );
  assert.deepEqual(uniqueNames(['名前なし', '名前なし']), ['名前なし', '名前なし (2)']);
});

/** 生成した ZIP を読み返す（無圧縮なのでヘッダーを辿るだけで取り出せる） */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const size = view.getUint32(offset + 22, true);
    const start = offset + 30 + nameLength + extraLength;
    entries.push({
      name: decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)),
      method: view.getUint16(offset + 8, true),
      crc: view.getUint32(offset + 14, true),
      flags: view.getUint16(offset + 6, true),
      data: bytes.subarray(start, start + size),
    });
    offset = start + size;
  }
  return { entries, centralOffset: offset };
}

test('ZIP を作って読み返せる', async () => {
  const zip = await createZip([
    { name: '写真 1.jpg', blob: new Blob([new Uint8Array([1, 2, 3, 4, 5])]), lastModified: Date.parse('2024-05-06T07:08:10Z') },
    { name: '写真 1.jpg', blob: new Blob(['hello world']), lastModified: Date.now() },
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const { entries, centralOffset } = readZip(bytes);

  assert.equal(zip.type, 'application/zip');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.name), ['写真 1.jpg', '写真 1 (2).jpg']);
  assert.deepEqual([...entries[0].data], [1, 2, 3, 4, 5]);
  assert.equal(new TextDecoder().decode(entries[1].data), 'hello world');
  assert.equal(entries[1].crc, 0x0d4a1185, '格納した内容の CRC が一致する');
  assert.ok(entries.every((entry) => entry.method === 0), '無圧縮 (store) で格納する');
  assert.ok(entries.every((entry) => (entry.flags & 0x0800) !== 0), 'ファイル名は UTF-8 として印を付ける');

  // セントラルディレクトリと EOCD
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  assert.equal(view.getUint16(eocd + 10, true), 2, '登録数');
  assert.equal(view.getUint32(eocd + 16, true), centralOffset, 'セントラルディレクトリの位置');
  assert.equal(view.getUint32(eocd + 12, true), eocd - centralOffset, 'セントラルディレクトリの大きさ');
});

test('空の ZIP も壊れない', async () => {
  const bytes = new Uint8Array(await (await createZip([])).arrayBuffer());
  assert.equal(bytes.length, 22);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x06054b50);
  assert.equal(view.getUint16(10, true), 0);
});
