/**
 * 最小限の MP4 (ISO BMFF) 組み立て。
 *
 * WebCodecs の VideoEncoder / AudioEncoder が吐き出す符号化済みデータは
 * そのままでは再生できないため、MP4 の箱に詰め直す必要がある。
 * ここでは追加ライブラリを使わずに、再生に必要な最小構成だけを書き出す。
 *
 * 配置は [ftyp][mdat][moov] の順（moov が最後）。
 * サンプルの実データは Blob として抱えるので、長い動画でもメモリを使い切らない。
 */

const MOVIE_TIMESCALE = 1000;
const FLUSH_THRESHOLD = 4 * 1024 * 1024; // これだけ溜まったら Blob に逃がす

// ---------------------------------------------------------------------------
// バイト列の組み立て
// ---------------------------------------------------------------------------

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const u8 = (...values) => Uint8Array.from(values);

function u16(value) {
  return u8((value >> 8) & 0xff, value & 0xff);
}

function u32(value) {
  return u8((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u64(value) {
  const high = Math.floor(value / 2 ** 32);
  return concat([u32(high), u32(value >>> 0)]);
}

function ascii(text) {
  return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff);
}

/** type(4 バイト) + 中身 に長さを付けた 1 つの箱 */
function box(type, ...parts) {
  const payload = concat(parts);
  return concat([u32(payload.length + 8), ascii(type), payload]);
}

/** version と flags を持つ箱 */
function fullBox(type, version, flags, ...parts) {
  return box(type, u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...parts);
}

/** 16.16 固定小数 */
function fixed16(value) {
  return u32(Math.round(value * 65536));
}

const UNITY_MATRIX = concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

// ---------------------------------------------------------------------------
// コーデックごとの設定ボックス
// ---------------------------------------------------------------------------

/** VP9 は帯域外の設定を持たないので、コーデック文字列と解像度から vpcC を作る */
function vpcC(codec, width, height) {
  const [, profile = '00', , depth = '08'] = codec.split('.');
  const pixels = width * height;
  // レベルは解像度に見合ったものを入れる（低すぎると再生を拒否される）
  const level = pixels <= 640 * 480 ? 21 : pixels <= 1280 * 720 ? 31 : pixels <= 1920 * 1080 ? 40 : 51;
  const bitDepth = Number(depth) || 8;
  return fullBox('vpcC', 1, 0,
    u8(Number(profile) || 0, level, (bitDepth << 4) | (1 << 1)), // bitDepth / 4:2:0 / 制限レンジ
    u8(1, 1, 1), // BT.709
    u16(0)); // 追加の初期化データは無し
}

/** AAC 用の esds（ES 記述子）。description は AudioSpecificConfig */
function esds(description, bitrate) {
  const descriptor = (tag, payload) => concat([u8(tag), u8(payload.length), payload]);
  const decoderSpecific = descriptor(0x05, description);
  const decoderConfig = descriptor(0x04, concat([
    u8(0x40, 0x15), // AAC / audio stream
    u8(0x00, 0x00, 0x00), // bufferSizeDB
    u32(bitrate), // maxBitrate
    u32(bitrate), // avgBitrate
    decoderSpecific,
  ]));
  const slConfig = descriptor(0x06, u8(0x02));
  const es = descriptor(0x03, concat([u16(1), u8(0x00), decoderConfig, slConfig]));
  return fullBox('esds', 0, 0, es);
}

/** Opus 用の dOps。description は OpusHead（リトルエンディアン）*/
function dOps(description) {
  const view = new DataView(description.buffer, description.byteOffset, description.byteLength);
  const channels = description[9];
  const preSkip = view.getUint16(10, true);
  const sampleRate = view.getUint32(12, true);
  const gain = view.getInt16(16, true);
  const family = description[18];
  return box('dOps', u8(0, channels), u16(preSkip), u32(sampleRate), u16(gain & 0xffff), u8(family));
}

function videoSampleEntry(track) {
  const { codec, description, width, height } = track;
  const name = codec.startsWith('avc1') ? 'avc1' : codec.startsWith('vp09') ? 'vp09' : 'av01';
  const config = name === 'avc1'
    ? box('avcC', description)
    : name === 'vp09'
      ? vpcC(codec, width, height)
      : box('av1C', description);
  return box(name,
    u8(0, 0, 0, 0, 0, 0), u16(1), // reserved, data_reference_index
    u16(0), u16(0), u32(0), u32(0), u32(0), // pre_defined, reserved
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), // 72dpi
    u32(0), u16(1), // reserved, frame_count
    new Uint8Array(32), // compressor name
    u16(0x0018), u16(0xffff), // depth, pre_defined
    config);
}

function audioSampleEntry(track) {
  const { codec, description, descriptionKind, channels, sampleRate, bitrate } = track;
  const name = codec.startsWith('mp4a') ? 'mp4a' : 'Opus';
  // 元の動画から音声をそのまま移す場合は、設定ボックスの中身も出来合いのものを使う
  const config = name === 'mp4a'
    ? esds(description, bitrate)
    : (descriptionKind === 'dOps' ? box('dOps', description) : dOps(description));
  return box(name,
    u8(0, 0, 0, 0, 0, 0), u16(1), // reserved, data_reference_index
    u32(0), u32(0), // reserved
    u16(channels), u16(16), // channel count, sample size
    u16(0), u16(0), // pre_defined, reserved
    u32(Math.min(sampleRate, 65535) << 16), // 16.16 固定小数のサンプリング周波数
    config);
}

// ---------------------------------------------------------------------------
// サンプル表
// ---------------------------------------------------------------------------

/** 同じ間隔が続く部分をまとめる（stts） */
function stts(samples) {
  const entries = [];
  for (const sample of samples) {
    const last = entries[entries.length - 1];
    if (last && last.delta === sample.delta) last.count += 1;
    else entries.push({ count: 1, delta: sample.delta });
  }
  return fullBox('stts', 0, 0, u32(entries.length),
    ...entries.flatMap((entry) => [u32(entry.count), u32(entry.delta)]));
}

function stss(samples) {
  const keys = samples.flatMap((sample, index) => (sample.keyFrame ? [index + 1] : []));
  if (keys.length === samples.length) return null; // すべてがキーフレームなら不要
  return fullBox('stss', 0, 0, u32(keys.length), ...keys.map(u32));
}

function stbl(track) {
  const entry = track.kind === 'video' ? videoSampleEntry(track) : audioSampleEntry(track);
  const sync = stss(track.samples);
  return box('stbl',
    fullBox('stsd', 0, 0, u32(1), entry),
    stts(track.samples),
    ...(sync ? [sync] : []),
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)), // 1 チャンク 1 サンプル
    fullBox('stsz', 0, 0, u32(0), u32(track.samples.length),
      ...track.samples.map((sample) => u32(sample.size))),
    fullBox('stco', 0, 0, u32(track.samples.length),
      ...track.samples.map((sample) => u32(sample.offset))));
}

function trak(track, index) {
  const isVideo = track.kind === 'video';
  const duration = track.samples.reduce((sum, sample) => sum + sample.delta, 0);
  const mediaHeader = isVideo
    ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) // graphicsmode + opcolor
    : fullBox('smhd', 0, 0, u16(0), u16(0)); // balance + reserved

  return box('trak',
    fullBox('tkhd', 0, 3, // enabled | in movie
      u32(0), u32(0), // creation / modification
      u32(index + 1), u32(0), // track_ID, reserved
      u32(Math.round((duration / track.timescale) * MOVIE_TIMESCALE)),
      u32(0), u32(0), // reserved
      u16(0), u16(0), // layer, alternate_group
      u16(isVideo ? 0 : 0x0100), u16(0), // volume, reserved
      UNITY_MATRIX,
      fixed16(isVideo ? track.width : 0),
      fixed16(isVideo ? track.height : 0)),
    box('mdia',
      fullBox('mdhd', 0, 0, u32(0), u32(0), u32(track.timescale), u32(duration), u16(0x55c4), u16(0)),
      fullBox('hdlr', 0, 0, u32(0), ascii(isVideo ? 'vide' : 'soun'), u32(0), u32(0), u32(0),
        ascii(`${isVideo ? 'VideoHandler' : 'SoundHandler'}\0`)),
      box('minf', mediaHeader,
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        stbl(track))));
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

export class Mp4Builder {
  constructor() {
    /** @type {Array<object>} */
    this.tracks = [];
    /** @type {Array<Blob|Uint8Array>} */
    this.parts = [];
    /** @type {Uint8Array[]} */
    this.buffered = [];
    this.bufferedLength = 0;
    this.mediaLength = 0;
  }

  /**
   * 映像トラックを追加する。
   * @param {{codec: string, description?: Uint8Array, width: number, height: number}} config
   */
  addVideoTrack(config) {
    this.tracks.push({ kind: 'video', timescale: 1_000_000, samples: [], ...config });
    return this.tracks.length - 1;
  }

  /**
   * 音声トラックを追加する。
   * descriptionKind に 'dOps' を渡すと、description をそのまま設定ボックスとして書く
   * （元の動画から音声を移すとき用）。
   * @param {{codec: string, description: Uint8Array, descriptionKind?: string,
   *   sampleRate: number, channels: number, bitrate: number, timescale?: number}} config
   */
  addAudioTrack(config) {
    this.tracks.push({
      kind: 'audio', timescale: config.timescale ?? config.sampleRate, samples: [], ...config,
    });
    return this.tracks.length - 1;
  }

  /**
   * サンプル（1 フレーム分の符号化データ）を追加する。
   * @param {number} trackIndex
   * @param {{data: Uint8Array, timestamp: number, duration: number, keyFrame: boolean}} sample
   *   timestamp と duration はマイクロ秒
   */
  addSample(trackIndex, sample) {
    const track = this.tracks[trackIndex];
    const toUnits = (micro) => Math.round((micro * track.timescale) / 1_000_000);
    const units = toUnits(sample.timestamp);
    const previous = track.samples[track.samples.length - 1];
    if (previous) {
      // 直前のサンプルの長さは、次のサンプルとの差で確定させる
      previous.delta = Math.max(1, units - previous.units);
    }
    track.samples.push({
      offset: this.mediaLength,
      size: sample.data.length,
      units,
      // 最後のサンプルの長さは、指定が無ければ直前と同じ長さとみなす
      delta: sample.duration ? Math.max(1, toUnits(sample.duration)) : (previous?.delta ?? 1),
      keyFrame: Boolean(sample.keyFrame),
    });
    this.buffered.push(sample.data);
    this.bufferedLength += sample.data.length;
    this.mediaLength += sample.data.length;
    if (this.bufferedLength >= FLUSH_THRESHOLD) this.flush();
  }

  flush() {
    if (this.bufferedLength === 0) return;
    this.parts.push(new Blob([concat(this.buffered)]));
    this.buffered = [];
    this.bufferedLength = 0;
  }

  /** タイムスタンプが並び替えられていないか（B フレームの有無）を確かめる */
  hasReorderedSamples() {
    return this.tracks.some((track) => track.samples.some(
      (sample, index) => index > 0 && sample.units < track.samples[index - 1].units,
    ));
  }

  /**
   * MP4 として書き出す。
   * @returns {Blob}
   */
  finish() {
    if (this.tracks.length === 0 || this.tracks[0].samples.length === 0) {
      throw new Error('書き出すデータがありません');
    }
    this.flush();

    const ftyp = box('ftyp', ascii('isom'), u32(512),
      ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
    const useLargeMdat = this.mediaLength + 8 > 0xffffffff;
    const mdatHeader = useLargeMdat
      ? concat([u32(1), ascii('mdat'), u64(this.mediaLength + 16)])
      : concat([u32(this.mediaLength + 8), ascii('mdat')]);
    const mediaStart = ftyp.length + mdatHeader.length;

    for (const track of this.tracks) {
      for (const sample of track.samples) sample.offset += mediaStart;
      if (track.samples[track.samples.length - 1].offset + track.samples[track.samples.length - 1].size > 0xffffffff) {
        throw new Error('ファイルが大きすぎます');
      }
    }

    const durationSeconds = Math.max(...this.tracks.map(
      (track) => track.samples.reduce((sum, sample) => sum + sample.delta, 0) / track.timescale,
    ));
    const movieDuration = Math.round(durationSeconds * MOVIE_TIMESCALE);
    const moov = box('moov',
      fullBox('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(movieDuration),
        u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), UNITY_MATRIX,
        u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(this.tracks.length + 1)),
      ...this.tracks.map((track, index) => trak(track, index)));

    return new Blob([ftyp, mdatHeader, ...this.parts, moov], { type: 'video/mp4' });
  }
}
