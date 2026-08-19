/**
 * 無圧縮 (store) の ZIP を組み立てる。
 *
 * JPEG や WebP は既に圧縮済みで deflate してもほぼ縮まないため、
 * ライブラリを足さずに標準 API だけでまとめられる store 方式を使う。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Uint8Array} bytes
 * @returns {number} CRC-32
 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** JS の Date を MS-DOS 形式の日付・時刻に変換する */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 同名のファイルがあれば「名前 (2).jpg」のように連番を付ける */
export function uniqueNames(names) {
  const used = new Map();
  return names.map((name) => {
    const count = used.get(name) ?? 0;
    used.set(name, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${stem} (${count + 1})${ext}`;
  });
}

/**
 * ZIP を組み立てて Blob として返す。
 * @param {Array<{name: string, blob: Blob, lastModified?: number}>} entries
 * @returns {Promise<Blob>}
 */
export async function createZip(entries) {
  const names = uniqueNames(entries.map((entry) => entry.name));
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [index, entry] of entries.entries()) {
    const nameBytes = encoder.encode(names[index]);
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const { time, date } = dosDateTime(new Date(entry.lastModified ?? Date.now()));
    const checksum = crc32(bytes);

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); // ローカルファイルヘッダー
    header.setUint16(4, 20, true); // 展開に必要なバージョン
    header.setUint16(6, 0x0800, true); // ファイル名は UTF-8
    header.setUint16(8, 0, true); // 無圧縮
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint32(14, checksum, true);
    header.setUint32(18, bytes.length, true);
    header.setUint32(22, bytes.length, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true); // 拡張フィールドなし
    parts.push(new Uint8Array(header.buffer), nameBytes, bytes);

    const entryHeader = new DataView(new ArrayBuffer(46));
    entryHeader.setUint32(0, 0x02014b50, true); // セントラルディレクトリ
    entryHeader.setUint16(4, 20, true);
    entryHeader.setUint16(6, 20, true);
    entryHeader.setUint16(8, 0x0800, true);
    entryHeader.setUint16(10, 0, true);
    entryHeader.setUint16(12, time, true);
    entryHeader.setUint16(14, date, true);
    entryHeader.setUint32(16, checksum, true);
    entryHeader.setUint32(20, bytes.length, true);
    entryHeader.setUint32(24, bytes.length, true);
    entryHeader.setUint16(28, nameBytes.length, true);
    entryHeader.setUint32(42, offset, true); // ローカルヘッダーの位置
    central.push(new Uint8Array(entryHeader.buffer), nameBytes);

    offset += 30 + nameBytes.length + bytes.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // EOCD
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
