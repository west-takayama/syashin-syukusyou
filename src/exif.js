/**
 * JPEG の Exif (APP1) を読み書きするための最小限のユーティリティ。
 *
 * Canvas で再エンコードすると Exif は完全に失われるため、
 * 「撮影日時などは残したいが、位置情報は残したくない」という要求に応えるには
 * 元画像の Exif を読み取り、必要なタグだけを選んで作り直す必要がある。
 *
 * ブラウザ API に依存しないので Node からもそのままテストできる。
 */

// ---------------------------------------------------------------------------
// タグ定義
// ---------------------------------------------------------------------------

/** IFD0（画像全体の情報）から引き継ぐタグ */
const IFD0_ALLOWLIST = new Set([
  0x010f, // Make
  0x0110, // Model
  0x0112, // Orientation（常に 1 に上書きする）
  0x011a, // XResolution
  0x011b, // YResolution
  0x0128, // ResolutionUnit
  0x0131, // Software
  0x0132, // DateTime
  0x013b, // Artist
  0x8298, // Copyright
]);

/** Exif SubIFD（撮影条件）から引き継ぐタグ */
const EXIF_ALLOWLIST = new Set([
  0x829a, // ExposureTime
  0x829d, // FNumber
  0x8822, // ExposureProgram
  0x8827, // ISOSpeedRatings
  0x9000, // ExifVersion
  0x9003, // DateTimeOriginal
  0x9004, // DateTimeDigitized
  0x9010, // OffsetTime
  0x9011, // OffsetTimeOriginal
  0x9012, // OffsetTimeDigitized
  0x9201, // ShutterSpeedValue
  0x9202, // ApertureValue
  0x9203, // BrightnessValue
  0x9204, // ExposureBiasValue
  0x9205, // MaxApertureValue
  0x9207, // MeteringMode
  0x9208, // LightSource
  0x9209, // Flash
  0x920a, // FocalLength
  0x9290, // SubSecTime
  0x9291, // SubSecTimeOriginal
  0x9292, // SubSecTimeDigitized
  0xa001, // ColorSpace（色が転ばないように必ず残す）
  0xa002, // PixelXDimension（出力サイズで上書きする）
  0xa003, // PixelYDimension（出力サイズで上書きする）
  0xa402, // ExposureMode
  0xa403, // WhiteBalance
  0xa404, // DigitalZoomRatio
  0xa405, // FocalLengthIn35mmFilm
  0xa406, // SceneCaptureType
  0xa432, // LensSpecification
  0xa433, // LensMake
  0xa434, // LensModel
]);

const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_GPS_IFD_POINTER = 0x8825;
const TAG_ORIENTATION = 0x0112;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;

const TYPE_SHORT = 3;
const TYPE_LONG = 4;

/** Exif の型 ID → 1 要素あたりのバイト数 */
const TYPE_SIZES = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

/** 値をバイト列のまま扱う型（エンディアンの影響を受けない） */
const RAW_TYPES = new Set([1, 2, 6, 7]);

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

// ---------------------------------------------------------------------------
// JPEG セグメントの走査
// ---------------------------------------------------------------------------

/**
 * JPEG から Exif の APP1 セグメントの中身（"Exif\0\0" から始まる部分）を取り出す。
 * 見つからなければ null。
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|null}
 */
export function extractExif(bytes) {
  const segment = findExifSegment(bytes);
  return segment ? bytes.subarray(segment.payloadStart, segment.end) : null;
}

/**
 * SOI 直後から順にマーカーを辿り、Exif の APP1 セグメントの位置を返す。
 * @param {Uint8Array} bytes
 */
function findExifSegment(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // SOS 以降は画像データなのでメタデータは存在しない
    if (marker === 0xda || marker === 0xd9) return null;
    // スタンドアロンマーカー（長さフィールドを持たない）
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) return null;
    const end = offset + 2 + length;
    if (end > bytes.length) return null;
    if (marker === 0xe1 && hasExifHeader(bytes, offset + 4)) {
      return { start: offset, payloadStart: offset + 4, end };
    }
    offset = end;
  }
  return null;
}

function hasExifHeader(bytes, at) {
  if (at + EXIF_HEADER.length > bytes.length) return false;
  return EXIF_HEADER.every((byte, i) => bytes[at + i] === byte);
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

/**
 * Exif ペイロードから Orientation（1〜8）を読む。無ければ 1。
 * @param {Uint8Array|null} exif "Exif\0\0" から始まるバイト列
 * @returns {number}
 */
export function readOrientation(exif) {
  const parsed = safeParse(exif);
  if (!parsed) return 1;
  const entry = parsed.ifd0.find((e) => e.tag === TAG_ORIENTATION);
  const value = entry && !RAW_TYPES.has(entry.type) ? entry.values[0] : null;
  return typeof value === 'number' && value >= 1 && value <= 8 ? value : 1;
}

function safeParse(exif) {
  try {
    return parseExif(exif);
  } catch {
    return null;
  }
}

/**
 * Exif ペイロードを IFD ごとのエントリ一覧に展開する。
 * @param {Uint8Array} exif
 */
export function parseExif(exif) {
  if (!exif || exif.length < 14) throw new Error('Exif ペイロードが短すぎます');
  if (!EXIF_HEADER.every((byte, i) => exif[i] === byte)) {
    throw new Error('Exif ヘッダーがありません');
  }
  const tiff = exif.subarray(6);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const byteOrder = view.getUint16(0, false);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) {
    throw new Error('TIFF ヘッダーのバイトオーダーが不正です');
  }
  const little = byteOrder === 0x4949;
  if (view.getUint16(2, little) !== 0x002a) throw new Error('TIFF マジックが不正です');

  const ifd0 = readIfd(view, tiff, view.getUint32(4, little), little);
  const exifPointer = pointerValue(ifd0, TAG_EXIF_IFD_POINTER);
  const gpsPointer = pointerValue(ifd0, TAG_GPS_IFD_POINTER);
  return {
    little,
    ifd0,
    exifIfd: exifPointer ? readIfd(view, tiff, exifPointer, little) : [],
    gpsIfd: gpsPointer ? readIfd(view, tiff, gpsPointer, little) : [],
  };
}

function pointerValue(entries, tag) {
  const entry = entries.find((e) => e.tag === tag);
  if (!entry || RAW_TYPES.has(entry.type)) return 0;
  const value = entry.values[0];
  return typeof value === 'number' ? value : 0;
}

function readIfd(view, tiff, offset, little) {
  if (offset <= 0 || offset + 2 > tiff.length) return [];
  const count = view.getUint16(offset, little);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = offset + 2 + i * 12;
    if (at + 12 > tiff.length) break;
    const tag = view.getUint16(at, little);
    const type = view.getUint16(at + 2, little);
    const size = TYPE_SIZES[type];
    if (!size) continue; // 未知の型は捨てる
    const length = view.getUint32(at + 4, little);
    const byteLength = size * length;
    let valueAt = at + 8;
    if (byteLength > 4) {
      valueAt = view.getUint32(at + 8, little);
      if (valueAt + byteLength > tiff.length) continue; // 壊れたエントリは捨てる
    }
    entries.push({ tag, type, values: readValues(view, tiff, valueAt, type, length, little) });
  }
  return entries;
}

function readValues(view, tiff, at, type, length, little) {
  if (RAW_TYPES.has(type)) return tiff.slice(at, at + length);
  const values = [];
  for (let i = 0; i < length; i += 1) {
    const p = at + i * TYPE_SIZES[type];
    switch (type) {
      case 3: values.push(view.getUint16(p, little)); break;
      case 4: values.push(view.getUint32(p, little)); break;
      case 5: values.push(view.getUint32(p, little), view.getUint32(p + 4, little)); break;
      case 8: values.push(view.getInt16(p, little)); break;
      case 9: values.push(view.getInt32(p, little)); break;
      case 10: values.push(view.getInt32(p, little), view.getInt32(p + 4, little)); break;
      case 11: values.push(view.getFloat32(p, little)); break;
      case 12: values.push(view.getFloat64(p, little)); break;
      default: break;
    }
  }
  return values;
}

/** RATIONAL 系は 1 要素につき 2 個の数値を持つ */
function elementCount(entry) {
  if (RAW_TYPES.has(entry.type)) return entry.values.length;
  if (entry.type === 5 || entry.type === 10) return entry.values.length / 2;
  return entry.values.length;
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

/**
 * 元の Exif から必要なタグだけを選んで、新しい Exif ペイロードを組み立てる。
 *
 * - Orientation は 1 に固定する（Canvas 側で回転済みのため）
 * - サムネイル (IFD1) は捨てる（古い画像が残るとビューアが混乱する）
 * - GPS は keepGps: true のときだけ引き継ぐ
 *
 * @param {Uint8Array|null} exif 元の "Exif\0\0" ペイロード
 * @param {{width?: number, height?: number, keepGps?: boolean}} [options]
 * @returns {Uint8Array|null} 新しいペイロード。引き継ぐものが無ければ null
 */
export function rebuildExif(exif, options = {}) {
  const parsed = safeParse(exif);
  if (!parsed) return null;
  const { width, height, keepGps = false } = options;

  const ifd0 = parsed.ifd0.filter((e) => IFD0_ALLOWLIST.has(e.tag)).map(cloneEntry);
  const exifIfd = parsed.exifIfd.filter((e) => EXIF_ALLOWLIST.has(e.tag)).map(cloneEntry);
  const gpsIfd = keepGps ? parsed.gpsIfd.map(cloneEntry) : [];

  // 回転はピクセルに焼き込んであるので、必ず「回転なし」にしておく
  upsert(ifd0, { tag: TAG_ORIENTATION, type: TYPE_SHORT, values: [1] });
  if (Number.isFinite(width) && Number.isFinite(height)) {
    upsert(exifIfd, { tag: TAG_PIXEL_X, type: TYPE_LONG, values: [Math.round(width)] });
    upsert(exifIfd, { tag: TAG_PIXEL_Y, type: TYPE_LONG, values: [Math.round(height)] });
  } else {
    remove(exifIfd, TAG_PIXEL_X);
    remove(exifIfd, TAG_PIXEL_Y);
  }

  if (ifd0.length === 0 && exifIfd.length === 0 && gpsIfd.length === 0) return null;

  // ポインタは後でオフセットを埋めるのでダミー値で追加しておく
  if (exifIfd.length > 0) upsert(ifd0, { tag: TAG_EXIF_IFD_POINTER, type: TYPE_LONG, values: [0] });
  if (gpsIfd.length > 0) upsert(ifd0, { tag: TAG_GPS_IFD_POINTER, type: TYPE_LONG, values: [0] });

  return serialize(ifd0, exifIfd, gpsIfd);
}

function cloneEntry(entry) {
  return {
    tag: entry.tag,
    type: entry.type,
    values: RAW_TYPES.has(entry.type) ? entry.values.slice() : entry.values.slice(),
  };
}

function upsert(entries, entry) {
  const index = entries.findIndex((e) => e.tag === entry.tag);
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
}

function remove(entries, tag) {
  const index = entries.findIndex((e) => e.tag === tag);
  if (index >= 0) entries.splice(index, 1);
}

function ifdByteLength(entries) {
  return entries.length === 0 ? 0 : 2 + entries.length * 12 + 4;
}

function serialize(ifd0, exifIfd, gpsIfd) {
  // Exif ではタグは昇順に並んでいる必要がある
  const sorted = (entries) => entries.slice().sort((a, b) => a.tag - b.tag);
  const ifds = { ifd0: sorted(ifd0), exifIfd: sorted(exifIfd), gpsIfd: sorted(gpsIfd) };

  const ifd0Offset = 8;
  const exifOffset = ifd0Offset + ifdByteLength(ifds.ifd0);
  const gpsOffset = exifOffset + ifdByteLength(ifds.exifIfd);
  const dataOffset = gpsOffset + ifdByteLength(ifds.gpsIfd);

  if (ifds.exifIfd.length > 0) setPointer(ifds.ifd0, TAG_EXIF_IFD_POINTER, exifOffset);
  if (ifds.gpsIfd.length > 0) setPointer(ifds.ifd0, TAG_GPS_IFD_POINTER, gpsOffset);

  const overflow = []; // 4 バイトに収まらない値の置き場
  let overflowLength = 0;
  for (const entries of [ifds.ifd0, ifds.exifIfd, ifds.gpsIfd]) {
    for (const entry of entries) {
      const bytes = encodeValue(entry);
      if (bytes.length > 4) {
        entry.dataOffset = dataOffset + overflowLength;
        overflow.push(bytes);
        overflowLength += bytes.length + (bytes.length % 2); // ワード境界に揃える
      }
      entry.bytes = bytes;
    }
  }

  const tiffLength = dataOffset + overflowLength;
  const out = new Uint8Array(6 + tiffLength);
  out.set(EXIF_HEADER, 0);
  const tiff = out.subarray(6);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  view.setUint16(0, 0x4949, true); // リトルエンディアンで書き出す
  view.setUint16(2, 0x002a, true);
  view.setUint32(4, ifd0Offset, true);

  writeIfd(view, tiff, ifd0Offset, ifds.ifd0);
  writeIfd(view, tiff, exifOffset, ifds.exifIfd);
  writeIfd(view, tiff, gpsOffset, ifds.gpsIfd);

  let cursor = dataOffset;
  for (const bytes of overflow) {
    tiff.set(bytes, cursor);
    cursor += bytes.length + (bytes.length % 2);
  }
  return out;
}

function setPointer(entries, tag, offset) {
  const entry = entries.find((e) => e.tag === tag);
  if (entry) entry.values = [offset];
}

function writeIfd(view, tiff, offset, entries) {
  if (entries.length === 0) return;
  view.setUint16(offset, entries.length, true);
  entries.forEach((entry, i) => {
    const at = offset + 2 + i * 12;
    view.setUint16(at, entry.tag, true);
    view.setUint16(at + 2, entry.type, true);
    view.setUint32(at + 4, elementCount(entry), true);
    if (entry.bytes.length > 4) {
      view.setUint32(at + 8, entry.dataOffset, true);
    } else {
      tiff.set(entry.bytes, at + 8);
      for (let p = entry.bytes.length; p < 4; p += 1) tiff[at + 8 + p] = 0;
    }
  });
  view.setUint32(offset + 2 + entries.length * 12, 0, true); // 次の IFD は無い
}

function encodeValue(entry) {
  if (RAW_TYPES.has(entry.type)) return Uint8Array.from(entry.values);
  const size = TYPE_SIZES[entry.type];
  const bytes = new Uint8Array(entry.values.length * (entry.type === 5 || entry.type === 10 ? size / 2 : size));
  const view = new DataView(bytes.buffer);
  entry.values.forEach((value, i) => {
    switch (entry.type) {
      case 3: view.setUint16(i * 2, value, true); break;
      case 4: view.setUint32(i * 4, value, true); break;
      case 5: view.setUint32(i * 4, value, true); break; // RATIONAL は LONG 2 個
      case 8: view.setInt16(i * 2, value, true); break;
      case 9: view.setInt32(i * 4, value, true); break;
      case 10: view.setInt32(i * 4, value, true); break; // SRATIONAL は SLONG 2 個
      case 11: view.setFloat32(i * 4, value, true); break;
      case 12: view.setFloat64(i * 8, value, true); break;
      default: break;
    }
  });
  return bytes;
}

// ---------------------------------------------------------------------------
// JPEG への差し込み
// ---------------------------------------------------------------------------

/**
 * JPEG に Exif の APP1 セグメントを差し込む（既存の Exif があれば置き換える）。
 * @param {Uint8Array} jpeg
 * @param {Uint8Array|null} exif "Exif\0\0" から始まるペイロード
 * @returns {Uint8Array}
 */
export function insertExif(jpeg, exif) {
  if (!exif || exif.length === 0) return jpeg;
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const segmentLength = exif.length + 2;
  if (segmentLength > 0xffff) return jpeg; // APP1 に収まらない場合は諦める

  const existing = findExifSegment(jpeg);
  const head = jpeg.subarray(2, existing ? existing.start : 2);
  const tail = jpeg.subarray(existing ? existing.end : 2);

  const out = new Uint8Array(2 + 4 + exif.length + head.length + tail.length);
  let cursor = 0;
  out.set([0xff, 0xd8], cursor); cursor += 2;
  out.set([0xff, 0xe1, (segmentLength >> 8) & 0xff, segmentLength & 0xff], cursor); cursor += 4;
  out.set(exif, cursor); cursor += exif.length;
  out.set(head, cursor); cursor += head.length;
  out.set(tail, cursor);
  return out;
}
