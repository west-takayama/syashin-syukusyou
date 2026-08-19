/**
 * テスト用の Exif 生成器。
 * 本体 (src/exif.js) とは独立した実装にして、ビッグエンディアンの Exif も作れるようにしている。
 */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

function encodeValue(entry, little) {
  const { type, values } = entry;
  if (type === 2) {
    const bytes = new TextEncoder().encode(`${values}\0`);
    return { bytes, count: bytes.length };
  }
  if (type === 1 || type === 7) {
    return { bytes: Uint8Array.from(values), count: values.length };
  }
  const bytes = new Uint8Array(values.length * TYPE_SIZE[type]);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => {
    if (type === 3) view.setUint16(i * 2, value, little);
    else if (type === 4) view.setUint32(i * 4, value, little);
    else if (type === 5) {
      view.setUint32(i * 8, value[0], little);
      view.setUint32(i * 8 + 4, value[1], little);
    }
  });
  return { bytes, count: values.length };
}

/**
 * @param {{ifd0?: Array, exifIfd?: Array, gpsIfd?: Array, little?: boolean}} spec
 * @returns {Uint8Array} "Exif\0\0" から始まるペイロード
 */
export function buildExif(spec) {
  const little = spec.little ?? false;
  const ifd0 = [...(spec.ifd0 ?? [])];
  const exifIfd = [...(spec.exifIfd ?? [])];
  const gpsIfd = [...(spec.gpsIfd ?? [])];

  const ifdSize = (entries) => (entries.length === 0 ? 0 : 2 + entries.length * 12 + 4);
  if (exifIfd.length > 0) ifd0.push({ tag: 0x8769, type: 4, values: [0] });
  if (gpsIfd.length > 0) ifd0.push({ tag: 0x8825, type: 4, values: [0] });
  ifd0.sort((a, b) => a.tag - b.tag);

  const ifd0Offset = 8;
  const exifOffset = ifd0Offset + ifdSize(ifd0);
  const gpsOffset = exifOffset + ifdSize(exifIfd);
  let dataOffset = gpsOffset + ifdSize(gpsIfd);

  for (const entry of ifd0) {
    if (entry.tag === 0x8769) entry.values = [exifOffset];
    if (entry.tag === 0x8825) entry.values = [gpsOffset];
  }

  const encoded = new Map();
  const overflow = [];
  for (const entries of [ifd0, exifIfd, gpsIfd]) {
    for (const entry of entries) {
      const value = encodeValue(entry, little);
      if (value.bytes.length > 4) {
        value.offset = dataOffset;
        dataOffset += value.bytes.length + (value.bytes.length % 2);
        overflow.push(value);
      }
      encoded.set(entry, value);
    }
  }

  const tiff = new Uint8Array(dataOffset);
  const view = new DataView(tiff.buffer);
  view.setUint16(0, little ? 0x4949 : 0x4d4d, false);
  view.setUint16(2, 0x002a, little);
  view.setUint32(4, ifd0Offset, little);

  const writeIfd = (offset, entries) => {
    if (entries.length === 0) return;
    view.setUint16(offset, entries.length, little);
    entries.forEach((entry, i) => {
      const at = offset + 2 + i * 12;
      const value = encoded.get(entry);
      view.setUint16(at, entry.tag, little);
      view.setUint16(at + 2, entry.type, little);
      view.setUint32(at + 4, value.count, little);
      if (value.bytes.length > 4) view.setUint32(at + 8, value.offset, little);
      else tiff.set(value.bytes, at + 8);
    });
    view.setUint32(offset + 2 + entries.length * 12, 0, little);
  };
  writeIfd(ifd0Offset, ifd0);
  writeIfd(exifOffset, exifIfd);
  writeIfd(gpsOffset, gpsIfd);
  for (const value of overflow) tiff.set(value.bytes, value.offset);

  const out = new Uint8Array(6 + tiff.length);
  out.set(new TextEncoder().encode('Exif\0\0'), 0);
  out.set(tiff, 6);
  return out;
}

/** APP1 に Exif を持つ、最小構成のダミー JPEG を作る */
export function buildJpeg(exif, { includeJfif = true } = {}) {
  const parts = [Uint8Array.from([0xff, 0xd8])];
  if (includeJfif) {
    const jfif = new Uint8Array(18);
    jfif.set([0xff, 0xe0, 0x00, 0x10], 0);
    jfif.set(new TextEncoder().encode('JFIF\0'), 4);
    parts.push(jfif);
  }
  if (exif) {
    const length = exif.length + 2;
    parts.push(Uint8Array.from([0xff, 0xe1, (length >> 8) & 0xff, length & 0xff]), exif);
  }
  parts.push(Uint8Array.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00])); // ダミーの量子化テーブル
  parts.push(Uint8Array.from([0xff, 0xda, 0x00, 0x04, 0x00, 0x00])); // SOS
  parts.push(Uint8Array.from([0x12, 0x34, 0x56, 0xff, 0xd9])); // 画像データ + EOI

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const jpeg = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    jpeg.set(part, offset);
    offset += part.length;
  }
  return jpeg;
}
