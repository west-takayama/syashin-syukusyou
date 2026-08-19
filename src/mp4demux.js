/**
 * MP4 / MOV の中身を取り出す（デマルチプレクサ）。
 *
 * 動画を「再生しながら」取り込むと再生速度に縛られるが、
 * ここで符号化済みのサンプルを直接取り出せば、WebCodecs のデコーダに
 * 一気に流し込めるので、端末の性能をそのまま使い切れる。
 *
 * ブラウザ API に依存しない部分が多いので、Node からもテストできる。
 */

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex']);
const READ_WINDOW = 8 * 1024 * 1024;

function boxType(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * バイト列の中の箱を順に返す。
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 */
function* boxes(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = Number(view.getBigUint64(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return;
    yield { type: boxType(bytes, offset + 4), start: offset, size, body: offset + headerSize };
    offset += size;
  }
}

function findBox(bytes, start, end, type) {
  for (const box of boxes(bytes, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

/** 入れ子の箱をパスで辿る（例: 'mdia/minf/stbl'） */
function findPath(bytes, box, path) {
  let current = box;
  for (const type of path.split('/')) {
    if (!current) return null;
    current = findBox(bytes, current.body, current.start + current.size, type);
  }
  return current;
}

// ---------------------------------------------------------------------------
// ファイル全体の走査
// ---------------------------------------------------------------------------

/** 先頭から順に箱の見出しだけを読み、moov の位置を探す */
async function locateMoov(file) {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const header = new Uint8Array(await file.slice(offset, Math.min(offset + 16, file.size)).arrayBuffer());
    if (header.length < 8) return null;
    const view = new DataView(header.buffer);
    let size = view.getUint32(0);
    if (size === 1) {
      if (header.length < 16) return null;
      size = Number(view.getBigUint64(8));
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < 8) return null;
    if (boxType(header, 4) === 'moov') return { start: offset, size };
    offset += size;
  }
  return null;
}

/** 順番に読む前提で、大きめの窓を保持しながらサンプルを切り出す */
class SampleReader {
  constructor(file, windowSize = READ_WINDOW) {
    this.file = file;
    this.windowSize = windowSize;
    this.buffer = new Uint8Array(0);
    this.start = 0;
  }

  async read(offset, size) {
    if (offset < this.start || offset + size > this.start + this.buffer.length) {
      const length = Math.min(this.file.size - offset, Math.max(this.windowSize, size));
      this.buffer = new Uint8Array(await this.file.slice(offset, offset + length).arrayBuffer());
      this.start = offset;
    }
    const from = offset - this.start;
    return this.buffer.subarray(from, from + size);
  }
}

// ---------------------------------------------------------------------------
// コーデック文字列
// ---------------------------------------------------------------------------

function hex(value, digits = 2) {
  return value.toString(16).padStart(digits, '0');
}

/** avcC から "avc1.640028" のような文字列を作る */
function avcCodec(config) {
  return `avc1.${hex(config[1])}${hex(config[2])}${hex(config[3])}`;
}

/** hvcC から "hvc1.1.6.L93.B0" のような文字列を作る */
function hevcCodec(config, name) {
  if (config.length < 13) return null;
  const view = new DataView(config.buffer, config.byteOffset, config.byteLength);
  const profileSpace = ['', 'A', 'B', 'C'][config[1] >> 6];
  const tier = (config[1] & 0x20) ? 'H' : 'L';
  const profile = config[1] & 0x1f;

  // 互換フラグはビットを逆順にしてから 16 進で表す
  let compatibility = view.getUint32(2);
  let reversed = 0;
  for (let i = 0; i < 32; i += 1) {
    reversed = (reversed << 1) | (compatibility & 1);
    compatibility >>>= 1;
  }
  const constraints = [...config.subarray(6, 12)];
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();

  return [
    `${name}.${profileSpace}${profile}`,
    (reversed >>> 0).toString(16),
    `${tier}${config[12]}`,
    ...constraints.map((byte) => hex(byte)),
  ].join('.');
}

/**
 * vpcC の中身から "vp09.00.31.08" を作る（profile / level / bitDepth）。
 * VP9 のコーデック文字列は 16 進ではなく 10 進 2 桁で書く。
 */
function vp9Codec(payload) {
  const decimal = (value) => String(value).padStart(2, '0');
  return `vp09.${decimal(payload[0])}.${decimal(payload[1])}.${decimal(payload[2] >> 4)}`;
}

/** esds から AudioSpecificConfig と種別を取り出す */
function parseEsds(bytes, start, end) {
  let offset = start + 4; // version + flags
  const readLength = () => {
    let length = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = bytes[offset++];
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return length;
  };
  let description = null;
  let objectType = 0;
  while (offset < end) {
    const tag = bytes[offset++];
    const length = readLength();
    if (tag === 0x03) {
      offset += 3; // ES_ID + flags
    } else if (tag === 0x04) {
      objectType = bytes[offset];
      offset += 13;
    } else if (tag === 0x05) {
      description = bytes.slice(offset, offset + length);
      break;
    } else {
      offset += length;
    }
  }
  return { description, objectType };
}

// ---------------------------------------------------------------------------
// サンプル表の展開
// ---------------------------------------------------------------------------

/**
 * stbl のサンプル表を、扱いやすい 1 次元の配列に展開する。
 * @returns {?Array<{offset: number, size: number, dts: number, cts: number, keyFrame: boolean, duration: number}>}
 */
function expandSamples(bytes, stbl) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stts = findBox(bytes, stbl.body, stbl.start + stbl.size, 'stts');
  const stsz = findBox(bytes, stbl.body, stbl.start + stbl.size, 'stsz');
  const stsc = findBox(bytes, stbl.body, stbl.start + stbl.size, 'stsc');
  const stco = findBox(bytes, stbl.body, stbl.start + stbl.size, 'stco')
    ?? findBox(bytes, stbl.body, stbl.start + stbl.size, 'co64');
  if (!stts || !stsz || !stsc || !stco) return null;
  const stss = findBox(bytes, stbl.body, stbl.start + stbl.size, 'stss');
  const ctts = findBox(bytes, stbl.body, stbl.start + stbl.size, 'ctts');

  // 各サンプルの大きさ
  const sampleSize = view.getUint32(stsz.body + 4);
  const sampleCount = view.getUint32(stsz.body + 8);
  const sizes = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    sizes[i] = sampleSize || view.getUint32(stsz.body + 12 + i * 4);
  }

  // 表示時刻
  const timeEntries = view.getUint32(stts.body + 4);
  const durations = new Array(sampleCount);
  let index = 0;
  for (let entry = 0; entry < timeEntries && index < sampleCount; entry += 1) {
    const count = view.getUint32(stts.body + 8 + entry * 8);
    const delta = view.getUint32(stts.body + 12 + entry * 8);
    for (let i = 0; i < count && index < sampleCount; i += 1) durations[index++] = delta;
  }
  while (index < sampleCount) durations[index++] = durations[index - 2] ?? 0;

  // 表示順の補正（B フレームがある場合）
  const offsets = new Array(sampleCount).fill(0);
  if (ctts) {
    const entries = view.getUint32(ctts.body + 4);
    let at = 0;
    for (let entry = 0; entry < entries && at < sampleCount; entry += 1) {
      const count = view.getUint32(ctts.body + 8 + entry * 8);
      const offset = view.getInt32(ctts.body + 12 + entry * 8);
      for (let i = 0; i < count && at < sampleCount; i += 1) offsets[at++] = offset;
    }
  }

  // キーフレーム
  const keyFrames = new Set();
  if (stss) {
    const count = view.getUint32(stss.body + 4);
    for (let i = 0; i < count; i += 1) keyFrames.add(view.getUint32(stss.body + 8 + i * 4) - 1);
  }

  // チャンクの位置とサンプルの割り当て
  const large = boxType(bytes, stco.start + 4) === 'co64';
  const chunkCount = view.getUint32(stco.body + 4);
  const chunkOffsets = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i += 1) {
    chunkOffsets[i] = large
      ? Number(view.getBigUint64(stco.body + 8 + i * 8))
      : view.getUint32(stco.body + 8 + i * 4);
  }
  const groupCount = view.getUint32(stsc.body + 4);
  const groups = [];
  for (let i = 0; i < groupCount; i += 1) {
    groups.push({
      firstChunk: view.getUint32(stsc.body + 8 + i * 12),
      samplesPerChunk: view.getUint32(stsc.body + 12 + i * 12),
    });
  }

  const samples = [];
  let sampleIndex = 0;
  let time = 0;
  for (let chunk = 0; chunk < chunkCount && sampleIndex < sampleCount; chunk += 1) {
    const group = groups.filter((entry) => entry.firstChunk <= chunk + 1).pop();
    if (!group) return null;
    let offset = chunkOffsets[chunk];
    for (let i = 0; i < group.samplesPerChunk && sampleIndex < sampleCount; i += 1) {
      samples.push({
        offset,
        size: sizes[sampleIndex],
        dts: time,
        cts: time + offsets[sampleIndex],
        duration: durations[sampleIndex],
        keyFrame: stss ? keyFrames.has(sampleIndex) : true,
      });
      offset += sizes[sampleIndex];
      time += durations[sampleIndex];
      sampleIndex += 1;
    }
  }
  return samples.length === sampleCount ? samples : null;
}

/**
 * tkhd の変換行列から回転角（0 / 90 / 180 / 270）を求める。
 * スマホの縦向き動画は、画素は横向きのままヘッダーの行列で回して表示している。
 */
function readRotation(bytes, trak) {
  const tkhd = findBox(bytes, trak.body, trak.start + trak.size, 'tkhd');
  if (!tkhd) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const matrixOffset = tkhd.body + (bytes[tkhd.body] === 1 ? 52 : 40);
  if (matrixOffset + 36 > tkhd.start + tkhd.size) return 0;
  const fixed = (index) => view.getInt32(matrixOffset + index * 4) / 65536;
  const [a, b, , c, d] = [fixed(0), fixed(1), fixed(2), fixed(3), fixed(4)];
  if (Math.abs(a) < 0.01 && Math.abs(d) < 0.01) {
    if (b > 0.9 && c < -0.9) return 90;
    if (b < -0.9 && c > 0.9) return 270;
  }
  if (a < -0.9 && d < -0.9) return 180;
  return 0;
}

/** 1 つの trak を読み解く */
function parseTrack(bytes, trak) {
  const mdia = findPath(bytes, trak, 'mdia');
  const mdhd = mdia && findBox(bytes, mdia.body, mdia.start + mdia.size, 'mdhd');
  const hdlr = mdia && findBox(bytes, mdia.body, mdia.start + mdia.size, 'hdlr');
  const stbl = findPath(bytes, trak, 'mdia/minf/stbl');
  if (!mdhd || !hdlr || !stbl) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[mdhd.body];
  const timescale = version === 1 ? view.getUint32(mdhd.body + 20) : view.getUint32(mdhd.body + 12);
  const duration = version === 1
    ? Number(view.getBigUint64(mdhd.body + 24))
    : view.getUint32(mdhd.body + 16);
  // hdlr: version/flags(4) + pre_defined(4) の後ろが handler_type
  const handler = boxType(bytes, hdlr.body + 8);

  const stsd = findBox(bytes, stbl.body, stbl.start + stbl.size, 'stsd');
  if (!stsd) return null;
  const entry = findBox(bytes, stsd.body + 8, stsd.start + stsd.size, boxType(bytes, stsd.body + 12));
  if (!entry) return null;

  const samples = expandSamples(bytes, stbl);
  if (!samples || samples.length === 0) return null;

  const common = { timescale, duration, samples, format: entry.type };
  if (handler === 'vide') {
    const width = view.getUint16(entry.body + 24);
    const height = view.getUint16(entry.body + 26);
    const configStart = entry.body + 78;
    const configEnd = entry.start + entry.size;
    const avcC = findBox(bytes, configStart, configEnd, 'avcC');
    const hvcC = findBox(bytes, configStart, configEnd, 'hvcC');
    const vpcC = findBox(bytes, configStart, configEnd, 'vpcC');
    const av1C = findBox(bytes, configStart, configEnd, 'av1C');

    let codec = null;
    let description = null;
    if (avcC) {
      description = bytes.slice(avcC.body, avcC.start + avcC.size);
      codec = avcCodec(description);
    } else if (hvcC) {
      description = bytes.slice(hvcC.body, hvcC.start + hvcC.size);
      codec = hevcCodec(description, entry.type === 'hev1' ? 'hev1' : 'hvc1');
    } else if (vpcC) {
      codec = vp9Codec(bytes.subarray(vpcC.body + 4, vpcC.start + vpcC.size)); // version と flags の後ろ
    } else if (av1C) {
      description = bytes.slice(av1C.body, av1C.start + av1C.size);
      codec = 'av01.0.08M.08';
    }
    if (!codec) return null;
    return { kind: 'video', codec, description, width, height, rotation: readRotation(bytes, trak), ...common };
  }
  if (handler === 'soun') {
    const channels = view.getUint16(entry.body + 16);
    const sampleRate = view.getUint32(entry.body + 24) >>> 16;
    const configEnd = entry.start + entry.size;
    const esdsBox = findBox(bytes, entry.body + 28, configEnd, 'esds');
    const dOpsBox = findBox(bytes, entry.body + 28, configEnd, 'dOps');
    let codec = null;
    let description = null;
    if (esdsBox) {
      const parsed = parseEsds(bytes, esdsBox.body, esdsBox.start + esdsBox.size);
      description = parsed.description;
      if (parsed.objectType === 0x40 && description) {
        const audioObjectType = description[0] >> 3;
        codec = `mp4a.40.${audioObjectType || 2}`;
      }
    } else if (dOpsBox) {
      codec = 'opus';
      description = bytes.slice(dOpsBox.body, dOpsBox.start + dOpsBox.size);
    }
    if (!codec) return null;
    return { kind: 'audio', codec, description, channels, sampleRate, ...common };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 入り口
// ---------------------------------------------------------------------------

/**
 * MP4 / MOV を読み解く。扱えない形式なら null。
 * @param {File|Blob} file
 * @returns {Promise<?{video: object, audio: ?object, duration: number, reader: SampleReader}>}
 */
export async function demuxMp4(file) {
  const located = await locateMoov(file);
  if (!located) return null;
  const moovBytes = new Uint8Array(await file.slice(located.start, located.start + located.size).arrayBuffer());
  const moov = { type: 'moov', start: 0, size: moovBytes.length, body: 8 };

  const tracks = [];
  for (const box of boxes(moovBytes, moov.body, moovBytes.length)) {
    if (box.type !== 'trak') continue;
    const track = parseTrack(moovBytes, box);
    if (track) tracks.push(track);
  }
  const video = tracks.find((track) => track.kind === 'video');
  if (!video) return null;
  const audio = tracks.find((track) => track.kind === 'audio') ?? null;

  // サンプルが復号順に並んでいない場合は扱わない（安全側に倒す）
  for (const track of [video, audio]) {
    if (!track) continue;
    for (let i = 1; i < track.samples.length; i += 1) {
      if (track.samples[i].dts < track.samples[i - 1].dts) return null;
    }
  }

  return {
    video,
    audio,
    duration: video.duration / video.timescale,
    reader: new SampleReader(file),
  };
}

export { SampleReader, boxes, findBox, findPath, expandSamples, hevcCodec, avcCodec, readRotation };
