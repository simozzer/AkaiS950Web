/*
 * Akai S900/S950 disk format - HFE decoding, MFM encoding, and the filesystem.
 *
 * A direct port of the C# in ..\AkaiS950List. No DOM and no Node APIs, so the same
 * file runs in a browser and under Node, where it is checked against the same corpus
 * of disk images as the original. See S950-Disk-Format.pdf for the format itself.
 */
var Akai = (function () {
  'use strict';

  // ------------------------------------------------------------------ HFE / MFM

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }

  /** Pull one side's cell bytes out of the interleaved 256-byte track blocks. */
  function sideCells(img, track, side) {
    var lut = u16(img, 18) * 512;
    if (lut + track * 4 + 3 >= img.length) return new Uint8Array(0);

    var tOff = u16(img, lut + track * 4) * 512;
    var tLen = u16(img, lut + track * 4 + 2);
    var half = tLen >> 1;
    if (half <= 0) return new Uint8Array(0);

    var out = new Uint8Array(half);
    var w = 0, pos = tOff;
    while (w < half) {
      var chunk = Math.min(256, half - w);
      var src = pos + (side === 0 ? 0 : 256);
      if (src < 0 || src + chunk > img.length) break;
      out.set(img.subarray(src, src + chunk), w);
      w += chunk;
      pos += 512;
    }
    return out;
  }

  /** Inverse of sideCells. */
  function writeSideCells(img, track, side, cells) {
    var lut = u16(img, 18) * 512;
    var tOff = u16(img, lut + track * 4) * 512;
    var tLen = u16(img, lut + track * 4 + 2);
    var half = tLen >> 1;
    var w = 0, pos = tOff;

    while (w < half && w < cells.length) {
      var chunk = Math.min(256, half - w);
      var dst = pos + (side === 0 ? 0 : 256);
      if (dst + chunk > img.length) break;
      img.set(cells.subarray(w, w + chunk), dst);
      w += chunk;
      pos += 512;
    }
  }

  /** One byte per MFM cell; HFE stores the first cell in bit 0. */
  function unpack(cells) {
    var bits = new Uint8Array(cells.length * 8);
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      for (var b = 0; b < 8; b++) bits[i * 8 + b] = (c >> b) & 1;
    }
    return bits;
  }

  function pack(bits) {
    var cells = new Uint8Array(bits.length >> 3);
    for (var i = 0; i < cells.length; i++) {
      var c = 0;
      for (var b = 0; b < 8; b++) c |= bits[i * 8 + b] << b;
      cells[i] = c;
    }
    return cells;
  }

  /** In MFM the cells alternate clock, data; the data bits sit at odd offsets. */
  function readByte(bits, g) {
    var n = bits.length, v = 0;
    for (var i = 0; i < 8; i++) v = (v << 1) | bits[(g + 2 * i + 1) % n];
    return v & 0xFF;
  }

  /** A clock bit is set only between two zero data bits. */
  function writeByte(bits, g, v, prev) {
    var n = bits.length;
    for (var i = 0; i < 8; i++) {
      var d = (v >> (7 - i)) & 1;
      bits[(g + 2 * i) % n] = (prev.v === 0 && d === 0) ? 1 : 0;
      bits[(g + 2 * i + 1) % n] = d;
      prev.v = d;
    }
  }

  /** CRC-16/CCITT, polynomial 0x1021. */
  function crc(d, len, c) {
    for (var i = 0; i < len; i++) {
      c = (c ^ (d[i] << 8)) & 0xFFFF;
      for (var b = 0; b < 8; b++)
        c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
    }
    return c;
  }

  var A1x3 = new Uint8Array([0xA1, 0xA1, 0xA1]);

  /**
   * Walk a track's bits, returning every sector found. `withData` decodes the
   * payload and checks CRCs; without it only the positions are collected, which
   * is what the writer needs.
   */
  function scanBits(bits, withData) {
    var out = [];
    var n = bits.length;
    if (n === 0) return out;

    var sr = 0, lastSync = -100, run = 0, pending = null;

    for (var p = 0; p < n; p++) {
      sr = ((sr << 1) | bits[p]) & 0xFFFF;
      if (sr !== 0x4489) continue;              // A1 with a missing clock

      run = (p - lastSync === 16) ? run + 1 : 1;
      lastSync = p;
      if (run < 3) continue;

      var g = p + 1;
      var mark = readByte(bits, g); g += 16;

      if (mark === 0xFE) {                      // ID address mark
        var id = new Uint8Array(4);
        for (var i = 0; i < 4; i++) { id[i] = readByte(bits, g); g += 16; }

        var idCrcOk = true;
        if (withData) {
          var cs = (readByte(bits, g) << 8); g += 16;
          cs |= readByte(bits, g); g += 16;
          var c = crc(A1x3, 3, 0xFFFF);
          c = crc(new Uint8Array([mark]), 1, c);
          c = crc(id, 4, c);
          idCrcOk = (c === cs);
        } else {
          g += 32;
        }

        pending = {
          cyl: id[0], head: id[1], sec: id[2], sizeCode: id[3],
          size: 128 << (id[3] & 7), idCrcOk: idCrcOk
        };
      } else if ((mark === 0xFB || mark === 0xF8) && pending) {
        pending.mark = mark;
        pending.dataBitPos = g;

        if (withData) {
          var sz = pending.size;
          var data = new Uint8Array(sz);
          for (var k = 0; k < sz; k++) { data[k] = readByte(bits, g); g += 16; }
          var dcs = (readByte(bits, g) << 8); g += 16;
          dcs |= readByte(bits, g); g += 16;

          var c2 = crc(A1x3, 3, 0xFFFF);
          c2 = crc(new Uint8Array([mark]), 1, c2);
          c2 = crc(data, sz, c2);

          pending.data = data;
          pending.dataCrcOk = (c2 === dcs);
        }
        out.push(pending);
        pending = null;
      }
    }
    return out;
  }

  /** Replace one sector's payload in place and recompute its CRC. */
  function patchField(bits, f, data) {
    if (data.length !== f.size) throw new Error('sector size mismatch');

    var n = bits.length;
    var g = f.dataBitPos;
    var prev = { v: bits[(g - 1 + n) % n] };    // last data bit of the address mark

    for (var i = 0; i < data.length; i++) { writeByte(bits, g, data[i], prev); g += 16; }

    var c = crc(A1x3, 3, 0xFFFF);
    c = crc(new Uint8Array([f.mark]), 1, c);
    c = crc(data, data.length, c);
    writeByte(bits, g, (c >> 8) & 0xFF, prev); g += 16;
    writeByte(bits, g, c & 0xFF, prev); g += 16;

    // The next cell's clock depends on the last CRC data bit, so fix it.
    var d0 = bits[(g + 1) % n];
    bits[g % n] = (prev.v === 0 && d0 === 0) ? 1 : 0;
  }

  var SPT = 5, SSZ = 1024;

  /** Decode every track into a linear sector image. */
  function extract(raw) {
    var tracks = raw[9], sides = raw[10];
    var img = new Uint8Array(tracks * sides * SPT * SSZ);
    var got = new Uint8Array(tracks * sides * SPT);
    var badCrc = 0;

    for (var t = 0; t < tracks; t++) {
      for (var s = 0; s < sides; s++) {
        var secs = scanBits(unpack(sideCells(raw, t, s)), true);
        for (var i = 0; i < secs.length; i++) {
          var sec = secs[i];
          if (!sec.data) continue;
          if (sec.sec < 1 || sec.sec > SPT || sec.cyl >= tracks || sec.head >= sides) continue;

          var lba = (sec.cyl * sides + sec.head) * SPT + (sec.sec - 1);
          if (lba < 0 || lba >= got.length || got[lba]) continue;   // keep the first good copy

          if (!sec.dataCrcOk || !sec.idCrcOk) badCrc++;
          img.set(sec.data.subarray(0, Math.min(SSZ, sec.data.length)), lba * SSZ);
          got[lba] = 1;
        }
      }
    }

    var missing = 0;
    for (var m = 0; m < got.length; m++) if (!got[m]) missing++;
    return { image: img, badCrc: badCrc, missing: missing };
  }

  /**
   * Write a sector image back into an HFE, patching each data field where it
   * already sits. Every Akai sector is 1024 bytes, so nothing moves: sync marks,
   * ID fields, gaps and track timing are untouched.
   */
  // ---------------------------------------------------- writing an HFE from nothing
  //
  // Patching an existing HFE only needs the sector payloads rewritten. Building one from
  // a raw .img needs the whole track: gaps, sync fields, address marks and the clock bits
  // between them. That is only worth doing if the result is indistinguishable from what
  // an Akai drive writes, so the layout below is not a guess at IBM System 34 - it is
  // measured from the library, where all 101 disks agree exactly:
  //
  //   one 512-byte header, identical on every disk
  //   80 tracks x 2 sides, 250 kbps, 25000 bytes per track, 6250 MFM bytes per side
  //   sectors 1..5 in order, no skew, on all 160 track/sides
  //   the first ID address mark at bit 4928 of every one of them
  //
  //   gap 4a   0x4E x 230
  //   sync     0x00 x 12
  //   IAM      0xC2 0xC2 0xC2 0xFC
  //   gap 1    0x4E x 50
  //   then five sectors of 1172 bytes:
  //     sync   0x00 x 12
  //     ID     0xA1 0xA1 0xA1 0xFE, cyl, head, sector, size=3, CRC
  //     gap 2  0x4E x 22
  //     sync   0x00 x 12
  //     data   0xA1 0xA1 0xA1 0xFB, 1024 bytes, CRC
  //     gap 3  0x4E x 86
  //   gap 4b   0x4E x 94
  //
  //   296 + 5 x 1172 + 94 = 6250
  //
  // buildTest() in imgtest.js checks the result byte for byte against the original HFE,
  // so this is held to reproduction, not merely to "it decodes".

  var HFE_HEADER = [
    0x48, 0x58, 0x43, 0x50, 0x49, 0x43, 0x46, 0x45,   // HXCPICFE
    0x00,           // format revision
    0x50,           // 80 tracks
    0x02,           // 2 sides
    0x00,           // ISOIBM_MFM
    0xFA, 0x00,     // 250 kbps
    0x00, 0x00,     // rpm, unused
    0x0C,           // interface mode
    0x01,           // unused
    0x01, 0x00      // track list at block 1
  ];

  var TRACK_BYTES = 25000;      // both sides, interleaved
  var SIDE_BYTES = 6250;        // MFM bytes per side
  var TRACK_STRIDE = 25088;     // 49 blocks of 512
  var GAP = 0x4E, SYNC = 0x00, IAM_MARK = 0xFC, IDAM = 0xFE, DAM = 0xFB;

  /** The MFM cell stream for one side of one track. */
  function buildSide(image, cyl, head, sides) {
    var bits = new Uint8Array(SIDE_BYTES * 16);
    var at = 0;
    var prev = { v: 0 };

    function put(value, times) {
      for (var i = 0; i < times; i++) { writeByte(bits, at, value, prev); at += 16; }
    }

    // A1 and C2 sync bytes carry a deliberately missing clock, so they cannot go
    // through writeByte - the pattern is written straight into the cells.
    function putSyncPattern(pattern, times) {
      for (var i = 0; i < times; i++) {
        for (var b = 0; b < 16; b++) bits[at + b] = (pattern >> (15 - b)) & 1;
        at += 16;
        prev.v = pattern & 1;
      }
    }

    put(GAP, 230);
    put(SYNC, 12);
    putSyncPattern(0x5224, 3);        // C2 C2 C2
    put(IAM_MARK, 1);
    put(GAP, 50);

    for (var s = 1; s <= SPT; s++) {
      var lba = (cyl * sides + head) * SPT + (s - 1);

      // --- ID field
      put(SYNC, 12);
      putSyncPattern(0x4489, 3);      // A1 A1 A1
      put(IDAM, 1);

      var id = new Uint8Array([cyl, head, s, 3]);
      put(id[0], 1); put(id[1], 1); put(id[2], 1); put(id[3], 1);

      var c = crc(A1x3, 3, 0xFFFF);
      c = crc(new Uint8Array([IDAM]), 1, c);
      c = crc(id, id.length, c);
      put((c >> 8) & 0xFF, 1);
      put(c & 0xFF, 1);

      put(GAP, 22);

      // --- data field
      put(SYNC, 12);
      putSyncPattern(0x4489, 3);
      put(DAM, 1);

      var from = lba * SSZ;
      var data = (from + SSZ <= image.length)
        ? image.subarray(from, from + SSZ)
        : new Uint8Array(SSZ);

      for (var i = 0; i < SSZ; i++) put(data[i], 1);

      var d = crc(A1x3, 3, 0xFFFF);
      d = crc(new Uint8Array([DAM]), 1, d);
      d = crc(data, data.length, d);
      put((d >> 8) & 0xFF, 1);
      put(d & 0xFF, 1);

      put(GAP, 86);
    }

    put(GAP, 94);

    if (at !== bits.length)
      throw new Error('track came to ' + (at / 16) + ' bytes, expected ' + SIDE_BYTES);

    return pack(bits);
  }

  /**
   * An HFE container holding this sector image. The inverse of extract(), and the only
   * way to write a disk that was opened from a raw .img.
   */
  function buildHfe(image, tracks, sides) {
    tracks = tracks || 80;
    sides = sides || 2;

    var size = 1024 + tracks * TRACK_STRIDE;
    var out = new Uint8Array(size);

    out.fill(0xFF, 0, 1024);
    out.set(HFE_HEADER, 0);

    // Each side is 12500 cell bytes, which is 48 whole 256-byte chunks and then 212 of
    // one - so 44 bytes of every side's last chunk are padding that writeSideCells never
    // touches. The drive that wrote the library left its gap fill running through them,
    // and 0x49 0x2A is exactly MFM-encoded 0x4E in this cell packing, so filling the
    // track area with that pattern first reproduces the padding instead of leaving holes.
    for (var i = 1024; i < size; i++) out[i] = (i & 1) ? 0x2A : 0x49;

    // track list: offset in 512-byte blocks, then length in bytes
    for (var t = 0; t < tracks; t++) {
      var off = (1024 + t * TRACK_STRIDE) / 512;
      var at = 512 + t * 4;
      out[at] = off & 0xFF;
      out[at + 1] = (off >> 8) & 0xFF;
      out[at + 2] = TRACK_BYTES & 0xFF;
      out[at + 3] = (TRACK_BYTES >> 8) & 0xFF;
    }

    for (var t = 0; t < tracks; t++)
      for (var s = 0; s < sides; s++)
        writeSideCells(out, t, s, buildSide(image, t, s, sides));

    return out;
  }

  function rebuild(rawHfe, image) {
    var out = new Uint8Array(rawHfe);           // copy
    var tracks = out[9], sides = out[10];

    for (var t = 0; t < tracks; t++) {
      for (var s = 0; s < sides; s++) {
        var cells = sideCells(out, t, s);
        if (cells.length === 0) continue;

        var bits = unpack(cells);
        var fields = scanBits(bits, false);
        var touched = false;

        for (var i = 0; i < fields.length; i++) {
          var f = fields[i];
          if (f.sec < 1 || f.sec > SPT || f.cyl >= tracks || f.head >= sides) continue;
          if (f.size !== SSZ) continue;

          var lba = (f.cyl * sides + f.head) * SPT + (f.sec - 1);
          var at = lba * SSZ;
          if (at + SSZ > image.length) continue;

          patchField(bits, f, image.subarray(at, at + SSZ));
          touched = true;
        }
        if (touched) writeSideCells(out, t, s, pack(bits));
      }
    }
    return out;
  }

  // -------------------------------------------------------------- filesystem

  var BLOCK = 1024, DIR_OFF = 0, DIR_ENTRIES = 64, ENTRY = 24;
  var FAT_OFF = 0x600, FAT_END = 0x8000, HEADER = 60;
  var PROG_HEADER = 38, KEYGROUP = 70, KG_NAME = 24, KG_ZONE_STRIDE = 22;
  var ARENA_DEFAULT = 0xC5F6;        // where keygroup records start in the sampler's RAM

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function noteName(n) {
    return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 2);
  }

  function cleanName(b, off) {
    var s = '';
    for (var i = 0; i < 10; i++) {
      var c = b[off + i];
      s += (c >= 0x20 && c < 0x7F) ? String.fromCharCode(c) : ' ';
    }
    return s.replace(/\s+$/, '');
  }

  function typeName(t) {
    return t === 'P' ? 'program' : t === 'S' ? 'sample'
         : t === 'D' ? 'drum set' : t === 'O' ? 'overall' : 'type ' + t;
  }

  function Disk(name, image, rawHfe, isHfe, badCrc, missing) {
    this.name = name;
    this.image = image;
    this.rawHfe = rawHfe;
    this.isHfe = isHfe;
    this.badCrc = badCrc;
    this.missing = missing;
    this.modified = false;
    this.entries = [];
    this.parseDirectory();
    this._arenaBase = this.deriveArenaBase();   // before any edit changes the counts
  }

  /**
   * Anything derived from the image - a decoded sample, a program's keygroups - is only
   * good until the image changes. Every write already announces itself by setting
   * `modified`, so that is where the counter lives: a cache keyed on `generation`
   * cannot go stale, and no edit has to remember to invalidate anything.
   */
  Object.defineProperty(Disk.prototype, 'modified', {
    get: function () { return this._modified === true; },
    set: function (v) {
      this._modified = v;
      this.generation = (this.generation || 0) + 1;
    },
    enumerable: true,
    configurable: true
  });

  Disk.prototype.totalBlocks = function () { return (this.image.length / BLOCK) | 0; };

  Disk.prototype.fat = function (block) {
    var o = FAT_OFF + block * 2;
    return (o + 1 >= this.image.length) ? FAT_END : u16(this.image, o);
  };

  Disk.prototype.freeBlocks = function () {
    var n = 0;
    for (var b = 4; b < this.totalBlocks(); b++) if (this.fat(b) === 0) n++;
    return n;
  };

  Disk.prototype.chain = function (start) {
    var blocks = [], seen = {}, b = start, total = this.totalBlocks();
    while (b !== FAT_END && b >= 0 && b < total && !seen[b]) {
      seen[b] = true;
      blocks.push(b);
      b = this.fat(b);
    }
    return blocks;
  };

  Disk.prototype.readFile = function (e) {
    var blocks = this.chain(e.startBlock);
    var buf = new Uint8Array(blocks.length * BLOCK);
    for (var i = 0; i < blocks.length; i++)
      buf.set(this.image.subarray(blocks[i] * BLOCK, blocks[i] * BLOCK + BLOCK), i * BLOCK);
    return buf.subarray(0, Math.min(e.length, buf.length));
  };

  Disk.prototype.parseDirectory = function () {
    this.entries = [];

    for (var i = 0; i < DIR_ENTRIES; i++) {
      var o = DIR_OFF + i * ENTRY;
      if (o + ENTRY > this.image.length) break;
      if (this.image[o] === 0) continue;                      // free slot

      var type = String.fromCharCode(this.image[o + 16]);
      if ('PSDO'.indexOf(type) < 0) continue;

      var len = this.image[o + 17] | (this.image[o + 18] << 8) | (this.image[o + 19] << 16);
      var start = u16(this.image, o + 20);
      if (start < 0 || start >= this.totalBlocks()) continue;

      var e = {
        slot: i,
        name: cleanName(this.image, o),
        type: type,
        typeName: typeName(type),
        length: len,
        startBlock: start
      };
      e.chainBlocks = this.chain(start).length;
      e.chainOk = e.chainBlocks >= Math.ceil(len / BLOCK);

      if (type === 'S') this.readSampleHeader(e);
      this.entries.push(e);
    }
  };

  Disk.prototype.readSampleHeader = function (e) {
    var o = e.startBlock * BLOCK;
    var b = this.image;
    if (o + HEADER > b.length) return;

    e.sampleCount = (b[o + 0x10] | (b[o + 0x11] << 8) | (b[o + 0x12] << 16) | (b[o + 0x13] << 24)) >>> 0;
    e.sampleRate = u16(b, o + 0x14);
    e.tuning = u16(b, o + 0x16);
    e.loudness = (u16(b, o + 0x18) << 16) >> 16;              // signed
    e.loopMode = String.fromCharCode(b[o + 0x1A]);
    e.loopEnd = (b[o + 0x1C] | (b[o + 0x1D] << 8) | (b[o + 0x1E] << 16) | (b[o + 0x1F] << 24)) >>> 0;
    e.loopStart = (b[o + 0x20] | (b[o + 0x21] << 8) | (b[o + 0x22] << 16) | (b[o + 0x23] << 24)) >>> 0;
    e.loopLength = (b[o + 0x24] | (b[o + 0x25] << 8) | (b[o + 0x26] << 16) | (b[o + 0x27] << 24)) >>> 0;
    e.loopDescriptorPtr = u16(b, o + 0x28);
    e.loopDirection = String.fromCharCode(b[o + 0x2B]);
    e.memoryAddress = b[o + 0x36] | (b[o + 0x37] << 8) | (b[o + 0x38] << 16);

    e.nominalPitch = (e.tuning / 16) | 0;
    e.finePitch = e.tuning % 16;
    e.seconds = e.sampleRate > 0 ? e.sampleCount / e.sampleRate : 0;
  };

  /** The sample as stored: signed 12-bit values, -2048..2047. See format section 6.2. */
  Disk.prototype.sampleWords12 = function (e) {
    if (!e || e.type !== 'S') return new Int16Array(0);

    var raw = this.readFile(e);
    var payload = raw.length - HEADER;
    if (payload <= 0) return new Int16Array(0);

    var n = Math.min(e.sampleCount, (payload * 2 / 3) | 0) & ~1;
    if (n <= 0) return new Int16Array(0);

    var half = n / 2;
    var pcm = new Int16Array(n);

    for (var i = 0; i < half; i++) {
      var nib = raw[HEADER + 2 * i];
      var a = (raw[HEADER + 2 * i + 1] << 4) | (nib >> 4);
      var b = (raw[HEADER + n + i] << 4) | (nib & 0x0F);
      pcm[i] = a >= 2048 ? a - 4096 : a;
      pcm[half + i] = b >= 2048 ? b - 4096 : b;
    }
    return pcm;
  };

  /** The inverse: pack signed 12-bit words into the split-nibble layout. */
  function packSampleData(words, count) {
    var n = Math.min(count, words.length) & ~1;
    if (n <= 0) return new Uint8Array(0);

    var half = n / 2;
    var buf = new Uint8Array(n + half);

    for (var i = 0; i < half; i++) {
      var a = clip12(words[i]), b = clip12(words[half + i]);
      buf[2 * i] = ((a & 0x0F) << 4) | (b & 0x0F);
      buf[2 * i + 1] = (a >> 4) & 0xFF;
      buf[n + i] = (b >> 4) & 0xFF;
    }
    return buf;
  }

  function clip12(v) {
    if (v > 2047) v = 2047;
    if (v < -2048) v = -2048;
    return v & 0xFFF;
  }

  Disk.prototype.keygroupCount = function (p) {
    return p.type === 'P' ? Math.max(0, ((p.length - PROG_HEADER) / KEYGROUP) | 0) : 0;
  };

  function parseZone(raw, o) {
    return {
      name: cleanName(raw, o),
      pointer: u16(raw, o + 16),
      fine: raw[o + 18],
      transpose: (raw[o + 19] << 24) >> 24,
      filter: raw[o + 20],
      loudness: (raw[o + 21] << 24) >> 24,
      get pitchOffset() { return this.transpose + this.fine / 256; },
      get inUse() { return this.name !== '' && this.name !== '2 SAMPLE' && this.pointer !== 0; }
    };
  }

  Disk.prototype.keygroups = function (p) {
    var out = [], n = this.keygroupCount(p);
    if (n === 0) return out;

    var body = this.readFile(p);
    for (var k = 0; k < n; k++) {
      var o = PROG_HEADER + k * KEYGROUP;
      if (o + KEYGROUP > body.length) break;

      var raw = body.subarray(o, o + KEYGROUP);
      out.push({
        index: k,
        highKey: raw[0],
        lowKey: raw[1],
        velocitySwitch: raw[2],
        vca: [raw[3], raw[4], raw[5], raw[6]],
        vcf: [raw[34], raw[35], raw[36], raw[37]],

        // The S900 had no filter envelope, so its programs leave these four bytes as
        // ASCII spaces - 87% of the library. Space is 32, which reads as a perfectly
        // plausible envelope setting, so anything using these has to know the difference
        // between 'set to 32' and 'never written'.
        vcfWritten: !(raw[34] === 0x20 && raw[35] === 0x20 &&
                      raw[36] === 0x20 && raw[37] === 0x20),
        vcfAmount: (raw[23] << 24) >> 24,
        velToFilter: raw[7],
        keyToFilter: raw[8],
        velToAttack: raw[9],
        velToRelease: (raw[10] << 24) >> 24,
        velToLoudness: raw[11],
        lfoDelay: raw[15], lfoRate: raw[16], lfoDepth: raw[17],
        flags: raw[18],
        constantPitch: (raw[18] & 0x01) !== 0,
        lfoDesync: (raw[18] & 0x04) !== 0,
        oneShot: (raw[18] & 0x08) !== 0,
        nextKeygroup: u16(raw, 68),
        zone1: parseZone(raw, KG_NAME),
        zone2: parseZone(raw, KG_NAME + KG_ZONE_STRIDE),
        raw: raw
      });
    }
    return out;
  };

  /** The drum set: a 22-byte header and eight 30-byte voices. See format section 8. */
  Disk.prototype.drumSet = function (e) {
    if (!e || e.type !== 'D') return null;

    var raw = this.readFile(e);
    if (raw.length < 22 + 8 * 30) return null;

    var voices = [];
    for (var i = 0; i < 8; i++) {
      var o = 22 + i * 30;
      voices.push({
        index: u16(raw, o),
        note: raw[o + 2],
        noteName: noteName(raw[o + 2]),
        raw: raw.subarray(o, o + 30)
      });
    }
    return { inUse: raw[0] === 0xFF, voices: voices };
  };

  // ------------------------------------------------------------------ writing

  var SAMPLE_RAM_BASE = 0x18000, LOOP_DESC_BASE = 0xB6F4;

  // A fully expanded S950. 71 of the 99 library disks need more than the 750 KB a stock
  // machine has, so the library itself assumes expansion - anything less would reject
  // Akai's own disks. Callers that know better should pass their own limit.
  var DEFAULT_SAMPLER_RAM = 2304 * 1024;
  var MAX_KEYGROUPS = 64, KG_CHAIN = 68, ZONE_PTR = KG_NAME + 16;

  function blocksFor(len) { return Math.ceil(len / BLOCK); }
  function ramSize(words) { return Math.floor((2 * words + 15) / 16) * 16; }

  /** 10-byte descriptors a sample consumes. See format section 6.1. */
  function loopRecords(words, mode) {
    var pages = Math.floor(2 * words / 131072);
    return mode === 'L' ? 3 + pages : mode === 'A' ? 3 * (1 + pages) : 2 + pages;
  }

  /** Up to 10 printable ASCII characters, upper case. */
  function normaliseName(name) {
    var s = '';
    name = (name || '').toUpperCase();
    for (var i = 0; i < name.length && s.length < 10; i++) {
      var c = name.charCodeAt(i);
      s += (c >= 0x20 && c < 0x7F) ? name.charAt(i) : ' ';
    }
    s = s.replace(/\s+$/, '');
    return s.length ? s : 'UNTITLED';
  }

  function putU16(b, o, v) { b[o] = v & 0xFF; b[o + 1] = (v >> 8) & 0xFF; }
  function putU32(b, o, v) {
    b[o] = v & 0xFF; b[o + 1] = (v >> 8) & 0xFF;
    b[o + 2] = (v >> 16) & 0xFF; b[o + 3] = (v >>> 24) & 0xFF;
  }

  Disk.prototype.setFat = function (block, value) {
    putU16(this.image, FAT_OFF + block * 2, value);
  };

  /** Write one byte into a file's payload. */
  Disk.prototype.pokeFile = function (e, offset, value) {
    var blocks = this.chain(e.startBlock);
    var bi = Math.floor(offset / BLOCK), bo = offset % BLOCK;
    if (bi < 0 || bi >= blocks.length) throw new Error('offset outside the file');
    this.image[blocks[bi] * BLOCK + bo] = value & 0xFF;
    this.modified = true;
  };

  /** Writes a file at a new length, taking more blocks or giving some back. */
  Disk.prototype.resizeFile = function (e, contents) {
    var chain = this.chain(e.startBlock);
    var need = blocksFor(contents.length);

    if (need > chain.length) {
      var want = need - chain.length, extra = [];
      for (var b = 4; b < this.totalBlocks() && extra.length < want; b++)
        if (this.fat(b) === 0) extra.push(b);

      if (extra.length < want)
        throw new Error('Not enough room: needs ' + want + ' more block(s), ' +
                        this.freeBlocks() + ' free.');
      chain = chain.concat(extra);
    }

    for (var i = 0; i < need; i++) {
      var off = chain[i] * BLOCK;
      this.image.fill(0, off, off + BLOCK);
      var take = Math.min(BLOCK, contents.length - i * BLOCK);
      if (take > 0) this.image.set(contents.subarray(i * BLOCK, i * BLOCK + take), off);
      this.setFat(chain[i], i === need - 1 ? FAT_END : chain[i + 1]);
    }
    for (var j = need; j < chain.length; j++) this.setFat(chain[j], 0);

    var d = DIR_OFF + e.slot * ENTRY;
    this.image[d + 17] = contents.length & 0xFF;
    this.image[d + 18] = (contents.length >> 8) & 0xFF;
    this.image[d + 19] = (contents.length >> 16) & 0xFF;
    this.modified = true;
  };

  /**
   * Writes a new file into free blocks and claims a directory slot. Nothing already
   * on the disk is moved. minSlot forces the entry past files whose order matters.
   */
  Disk.prototype.addFile = function (name, type, contents, minSlot) {
    var clean = normaliseName(name);

    // Names must be unique within a type, not across the disk: the library's own
    // images routinely name a program after the sample it plays.
    for (var x = 0; x < this.entries.length; x++)
      if (this.entries[x].type === type &&
          this.entries[x].name.toUpperCase() === clean.toUpperCase())
        throw new Error("'" + clean + "' is already used by another " + typeName(type) + ".");

    var need = blocksFor(contents.length), free = [];
    for (var b = 4; b < this.totalBlocks() && free.length < need; b++)
      if (this.fat(b) === 0) free.push(b);

    if (free.length < need)
      throw new Error('Not enough room: needs ' + need + ' blocks, ' + this.freeBlocks() + ' free.');

    var slot = -1;
    for (var i = Math.max(0, minSlot); i < DIR_ENTRIES; i++)
      if (this.image[DIR_OFF + i * ENTRY] === 0) { slot = i; break; }
    if (slot < 0) throw new Error('No free directory slot after the last file of this type.');

    for (var k = 0; k < need; k++) {
      var off = free[k] * BLOCK;
      this.image.fill(0, off, off + BLOCK);
      var take = Math.min(BLOCK, contents.length - k * BLOCK);
      if (take > 0) this.image.set(contents.subarray(k * BLOCK, k * BLOCK + take), off);
      this.setFat(free[k], k === need - 1 ? FAT_END : free[k + 1]);
    }

    var d = DIR_OFF + slot * ENTRY;
    this.image.fill(0, d, d + ENTRY);
    for (var c = 0; c < 10; c++)
      this.image[d + c] = c < clean.length ? clean.charCodeAt(c) : 32;
    this.image[d + 16] = type.charCodeAt(0);
    this.image[d + 17] = contents.length & 0xFF;
    this.image[d + 18] = (contents.length >> 8) & 0xFF;
    this.image[d + 19] = (contents.length >> 16) & 0xFF;
    putU16(this.image, d + 20, free[0]);

    this.modified = true;
    this.parseDirectory();

    for (var q = 0; q < this.entries.length; q++)
      if (this.entries[q].slot === slot) return this.entries[q];
    throw new Error('the new entry did not read back');
  };

  /**
   * Samples sit back to back in RAM in directory order, so one changing size moves
   * all the rest. Shifting rather than re-deriving keeps any irregular arrangement.
   */
  Disk.prototype.shiftSampleRam = function (afterSlot, ramDelta, ptrDelta) {
    if (!ramDelta && !ptrDelta) return 0;
    var moved = 0, self = this;

    this.entries.forEach(function (s) {
      if (s.type !== 'S' || s.slot <= afterSlot) return;
      var o = s.startBlock * BLOCK;
      var ram = s.memoryAddress + ramDelta;
      var ptr = s.loopDescriptorPtr + ptrDelta;
      if (ram < 0 || ptr < 0) return;

      self.image[o + 0x36] = ram & 0xFF;
      self.image[o + 0x37] = (ram >> 8) & 0xFF;
      self.image[o + 0x38] = (ram >> 16) & 0xFF;
      putU16(self.image, o + 0x28, ptr & 0xFFFF);
      moved++;
    });
    this.modified = true;
    return moved;
  };

  /** Adds a sample from signed 12-bit words. See format sections 6.1 and 6.2. */
  Disk.prototype.addSample = function (name, words12, sampleRate, nominalPitch, finePitch, loopMode) {
    var n = words12.length & ~1;
    if (n < 2) throw new Error('There is no audio to add.');

    var ram = SAMPLE_RAM_BASE, ptr = LOOP_DESC_BASE, lastSlot = -1;
    this.entries.forEach(function (s) {
      if (s.type !== 'S' || s.slot <= lastSlot) return;
      ram = s.memoryAddress + ramSize(s.sampleCount);
      ptr = s.loopDescriptorPtr + 10 * loopRecords(s.sampleCount, s.loopMode);
      lastSlot = s.slot;
    });

    var data = packSampleData(words12, n);
    var file = new Uint8Array(HEADER + data.length);
    var clean = normaliseName(name);

    for (var i = 0; i < 10; i++) file[i] = i < clean.length ? clean.charCodeAt(i) : 32;
    putU32(file, 0x10, n);
    putU16(file, 0x14, sampleRate);
    putU16(file, 0x16, nominalPitch * 16 + (finePitch || 0));
    file[0x1A] = (loopMode || 'O').charCodeAt(0);
    putU32(file, 0x1C, n);                      // end marker
    putU32(file, 0x20, 0);                      // start marker
    putU32(file, 0x24, Math.min(n, 2000));      // loop length, the panel default
    putU16(file, 0x28, ptr);
    file[0x2B] = 0x4E;                          // 'N', loop direction
    file[0x36] = ram & 0xFF;
    file[0x37] = (ram >> 8) & 0xFF;
    file[0x38] = (ram >> 16) & 0xFF;
    file.set(data, HEADER);

    return this.addFile(clean, 'S', file, lastSlot + 1);
  };

  /**
   * Writes a sample at a new length. Markers are supplied by the caller: a resample
   * scales them, a trim shifts them. Returns the blocks freed, negative if it grew.
   */
  Disk.prototype.rewriteSample = function (e, words12, n, sampleRate, end, start, loopLength) {
    var oldWords = e.sampleCount;
    var data = packSampleData(words12, n);
    var newLength = HEADER + data.length;
    var had = this.chain(e.startBlock).length;

    var file = new Uint8Array(newLength);
    file.set(this.image.subarray(e.startBlock * BLOCK, e.startBlock * BLOCK + HEADER), 0);

    putU32(file, 0x10, n);
    putU16(file, 0x14, sampleRate);
    putU32(file, 0x1C, end);
    putU32(file, 0x20, start);
    putU32(file, 0x24, loopLength);
    file.set(data, HEADER);

    this.resizeFile(e, file);

    // Shift rather than re-derive, so any irregular arrangement is preserved.
    this.shiftSampleRam(e.slot,
      ramSize(n) - ramSize(oldWords),
      10 * (loopRecords(n, e.loopMode) - loopRecords(oldWords, e.loopMode)));

    this.modified = true;
    this.parseDirectory();
    return had - blocksFor(newLength);
  };

  function scaleMarker(marker, oldWords, newWords) {
    if (oldWords <= 0) return 0;
    var v = Math.floor(marker * newWords / oldWords);
    return v < 0 ? 0 : Math.min(v, newWords);
  }

  /** Replaces a sample's audio with a version of any length, growing the file if needed. */
  Disk.prototype.replaceSampleAudio = function (e, words12, sampleRate) {
    var n = words12.length & ~1;
    if (n < 2) throw new Error('There would be no audio left.');

    var old = e.sampleCount;
    return this.rewriteSample(e, words12, n, sampleRate,
      scaleMarker(e.loopEnd, old, n),
      scaleMarker(e.loopStart, old, n),
      scaleMarker(e.loopLength, old, n));
  };

  /** Varispeed: only the rate changes, so the pitch moves and nothing is reallocated. */
  /** The entry for a slot, read back after the directory has been parsed again. */
  Disk.prototype.entryAt = function (slot) {
    for (var i = 0; i < this.entries.length; i++)
      if (this.entries[i].slot === slot) return this.entries[i];
    return null;
  };

  Disk.prototype.pokeFile32 = function (e, offset, value) {
    for (var i = 0; i < 4; i++) this.pokeFile(e, offset + i, (value >>> (8 * i)) & 0xFF);
  };

  /**
   * The loop mode is not just a byte in the header. It decides how many 10-byte
   * descriptors the sample takes in the table that follows the keygroup arena - a
   * looping sample takes one more than a one-shot, an alternating one more again - so
   * changing it moves the descriptor pointer of every sample after it. The library
   * bears the chain out: 1,002 of its 1,011 consecutive samples point exactly where
   * the one before them ends.
   *
   * Poking 0x1A on its own, as this used to, leaves the rest of the disk pointing into
   * the wrong records.
   */
  Disk.prototype.setLoopMode = function (e, mode) {
    if ('OLA'.indexOf(mode) < 0 || mode.length !== 1)
      throw new Error('a loop mode is O, L or A, not ' + JSON.stringify(mode));
    var was = e.loopMode;
    if (mode === was) return e;

    this.pokeFile(e, 0x1A, mode.charCodeAt(0));
    this.shiftSampleRam(e.slot, 0,
      10 * (loopRecords(e.sampleCount, mode) - loopRecords(e.sampleCount, was)));

    this.modified = true;
    this.parseDirectory();
    return this.entryAt(e.slot) || e;
  };

  /**
   * Where a sample loops. The machine plays end-length .. end, and the loop start field
   * is left at 0 in three quarters of the library, so that is what this writes: the end,
   * the length, and a start of 0. Anything that reads a loop here honours
   * max(start, end - length), so a 0 start means the length decides.
   */
  Disk.prototype.setLoop = function (e, end, length, mode) {
    var n = e.sampleCount;
    end = Math.max(2, Math.min(Math.round(end), n));
    length = Math.max(2, Math.min(Math.round(length), end));
    if (end % 2 || length % 2) throw new Error('a loop end and length are whole words, in pairs');

    this.pokeFile32(e, 0x1C, end);
    this.pokeFile32(e, 0x20, 0);
    this.pokeFile32(e, 0x24, length);
    this.modified = true;
    this.parseDirectory();

    var now = this.entryAt(e.slot) || e;
    return mode ? this.setLoopMode(now, mode) : now;
  };

  Disk.prototype.setSampleRate = function (e, sampleRate) {
    if (sampleRate < 1000 || sampleRate > 48000)
      throw new Error(sampleRate + ' Hz is outside anything the sampler uses.');
    this.pokeFile(e, 0x14, sampleRate & 0xFF);
    this.pokeFile(e, 0x15, (sampleRate >> 8) & 0xFF);
    this.modified = true;
    this.parseDirectory();
  };

  /**
   * Finds the silence before a sample's first audible word. Only the front: the tail
   * is where a loop lives, and where a decay fades below any threshold worth picking.
   */
  Disk.prototype.planTrim = function (e, threshold) {
    var plan = { front: 0, newWords: 0, blocksFreed: 0, seconds: 0, anything: false };
    if (!e || e.type !== 'S') return plan;

    var w = this.sampleWords12(e);
    if (w.length < 4) return plan;

    var first = 0;
    while (first < w.length && Math.abs(w[first]) <= threshold) first++;
    if (first >= w.length) return plan;                 // silent throughout

    if (((w.length - first) & 1) !== 0) first--;        // keep the count even
    if (first <= 0) return plan;

    plan.front = first;
    plan.newWords = w.length - first;
    plan.blocksFreed = blocksFor(e.length) - blocksFor(HEADER + plan.newWords * 3 / 2);
    plan.seconds = e.sampleRate > 0 ? first / e.sampleRate : 0;
    plan.anything = true;
    return plan;
  };

  /** Removes the leading silence. Markers move with the audio. */
  Disk.prototype.trimSample = function (e, threshold) {
    var plan = this.planTrim(e, threshold);
    if (!plan.anything) throw new Error('There is no leading silence to trim.');

    var w = this.sampleWords12(e);
    var kept = w.subarray(plan.front);
    var n = plan.newWords;

    var shift = function (m) { var v = m - plan.front; return v < 0 ? 0 : Math.min(v, n); };
    return this.rewriteSample(e, kept, n, e.sampleRate,
      e.loopEnd >= w.length ? n : shift(e.loopEnd),
      shift(e.loopStart),
      Math.min(e.loopLength, n));
  };

  /**
   * Renames a file, writing the new name into both places it is held: the directory
   * entry and the file's own header. Renaming a sample also rewrites every keygroup
   * zone that named it. Returns the number of references updated.
   */
  Disk.prototype.renameFile = function (e, newName) {
    var clean = normaliseName(newName);
    if (clean === e.name) return 0;

    for (var i = 0; i < this.entries.length; i++)
      if (this.entries[i].slot !== e.slot && this.entries[i].type === e.type &&
          this.entries[i].name.toUpperCase() === clean.toUpperCase())
        throw new Error("'" + clean + "' is already used by another " + e.typeName + ".");

    var old = e.name;
    var d = DIR_OFF + e.slot * ENTRY;
    for (var c = 0; c < 10; c++)
      this.image[d + c] = c < clean.length ? clean.charCodeAt(c) : 32;

    if (e.type === 'P' || e.type === 'S')
      for (c = 0; c < 10; c++)
        this.pokeFile(e, c, c < clean.length ? clean.charCodeAt(c) : 32);

    var refs = e.type === 'S' ? this.retargetSampleReferences(old, clean) : 0;

    this.modified = true;
    this.parseDirectory();
    return refs;
  };

  /** Zones name their sample directly, so a rename has to follow them. */
  Disk.prototype.retargetSampleReferences = function (oldName, newName) {
    var changed = 0, self = this;

    this.entries.forEach(function (p) {
      if (p.type !== 'P') return;
      var data = self.readFile(p);
      var count = self.keygroupCount(p);

      for (var k = 0; k < count; k++) {
        var kg = PROG_HEADER + k * KEYGROUP;
        for (var z = 0; z < 2; z++) {
          var off = kg + KG_NAME + z * KG_ZONE_STRIDE;
          if (off + 10 > data.length) continue;
          if (cleanName(data, off).toUpperCase() !== oldName.toUpperCase()) continue;

          for (var i = 0; i < 10; i++)
            self.pokeFile(p, off + i, i < newName.length ? newName.charCodeAt(i) : 32);
          changed++;
        }
      }
    });
    return changed;
  };

  /** Which keygroup zones name a given sample. */
  Disk.prototype.sampleUsers = function (name) {
    var want = (name || '').trim().toUpperCase(), users = [], self = this;
    if (!want) return users;

    this.entries.forEach(function (p) {
      if (p.type !== 'P') return;
      self.keygroups(p).forEach(function (kg, k) {
        [kg.zone1, kg.zone2].forEach(function (z, zi) {
          if ((z.name || '').trim().toUpperCase() === want)
            users.push({ program: p.name, keygroup: k + 1, zone: zi + 1 });
        });
      });
    });
    return users;
  };

  /**
   * Removes a sample and everything that pointed at it.
   *
   * Three things have to move together or the disk is left inconsistent:
   *   - zones naming it are cleared to the unused placeholder;
   *   - zones naming a *later* sample have their pointer pulled back one record,
   *     because those pointers are the sample's position in directory order and
   *     every later sample has just moved down one;
   *   - later samples shift down in sample RAM by the space this one occupied.
   * Then its blocks go back to the free pool and its directory slot is cleared.
   */
  /**
   * Squeeze the empty slots out of the directory, keeping the order of what is left.
   *
   * Every one of the 100 factory images holds its files in slots 0..n-1 with no holes,
   * so the sampler is entitled to read the directory until the first empty slot and
   * stop. Deleting a file by blanking its slot leaves exactly such a hole, and anything
   * past it becomes invisible - or worse, the programs before it load and then reference
   * samples that never arrived. Compacting keeps the shape the sampler expects. Relative
   * order is preserved, so the position-based zone pointers stay correct.
   */
  Disk.prototype.compactDirectory = function () {
    var moved = 0, write = 0;
    for (var read = 0; read < DIR_ENTRIES; read++) {
      var from = DIR_OFF + read * ENTRY;
      if (this.image[from] === 0) continue;

      if (write !== read) {
        var to = DIR_OFF + write * ENTRY;
        this.image.copyWithin(to, from, from + ENTRY);
        this.image.fill(0, from, from + ENTRY);
        moved++;
      }
      write++;
    }
    if (moved) { this.modified = true; this.parseDirectory(); }
    return moved;
  };

  Disk.prototype.deleteSample = function (e) {
    if (!e || e.type !== 'S') throw new Error('not a sample');

    var self = this;
    var samples = this.entries.filter(function (x) { return x.type === 'S'; })
                              .sort(function (a, b) { return a.slot - b.slot; });

    var index = -1, byName = {};
    samples.forEach(function (s, i) {
      byName[s.name.trim().toUpperCase()] = i;
      if (s.slot === e.slot) index = i;
    });
    if (index < 0) throw new Error('that sample is not on this disk');

    var gone = e.name.trim().toUpperCase();
    var cleared = 0, repointed = 0;

    this.entries.forEach(function (p) {
      if (p.type !== 'P') return;

      var data = self.readFile(p);
      var count = self.keygroupCount(p);

      for (var k = 0; k < count; k++) {
        for (var z = 0; z < 2; z++) {
          var off = PROG_HEADER + k * KEYGROUP + KG_NAME + z * KG_ZONE_STRIDE;
          if (off + 18 > data.length) continue;

          var name = cleanName(data, off).trim().toUpperCase();
          if (name === gone) { self.clearZone(p, k, z); cleared++; continue; }

          var at = byName[name];
          if (at === undefined || at <= index) continue;

          var ptr = data[off + 16] | (data[off + 17] << 8);
          if (!ptr) continue;

          var moved = ptr - KEYGROUP;
          self.pokeFile(p, off + 16, moved & 0xFF);
          self.pokeFile(p, off + 17, (moved >> 8) & 0xFF);
          repointed++;
        }
      }
    });

    this.shiftSampleRam(e.slot,
      -ramSize(e.sampleCount),
      -10 * loopRecords(e.sampleCount, e.loopMode));

    var chain = this.chain(e.startBlock);
    chain.forEach(function (b) { self.setFat(b, 0); });

    var d = DIR_OFF + e.slot * ENTRY;
    this.image.fill(0, d, d + ENTRY);

    this.modified = true;
    this.compactDirectory();
    this.parseDirectory();
    this.rebuildPointers();
    this.parseDirectory();
    return { cleared: cleared, repointed: repointed, blocksFreed: chain.length };
  };

  // ------------------------------------------------------- keygroups: add/delete

  function chainOf(file, index) {
    var o = PROG_HEADER + index * KEYGROUP + KG_CHAIN;
    return o + 1 < file.length ? (file[o] | (file[o + 1] << 8)) : 0;
  }

  /**
   * The RAM address of a program's first keygroup record. Not stored: each record
   * points at the next, so the first address is the first pointer less one record.
   * A single-keygroup program stores no pointer, so its base is inferred.
   */

  // ------------------------------------------------- the keygroup / sample arena
  //
  // Keygroup records and sample descriptors share one region of the sampler's RAM,
  // laid out in directory order: each program's keygroups packed 70 bytes apart, then
  // a single empty 70-byte record before the next program, and after the last program
  // the table of sample descriptors that the zone pointers index into.
  //
  // So the whole arrangement follows from three numbers - where the arena starts, how
  // many programs there are and how many keygroups in total:
  //
  //     sample table = arena + 70 * (keygroups + programs - 1)
  //
  // Verified against the library: this predicts all 1774 keygroup chain pointers on all
  // 98 disks that have them, exactly, and the sample table base on every one.
  //
  // It is recomputed rather than adjusted. An earlier version shifted the stored
  // pointers by a delta on each edit, which quietly conflated the chain pointers with
  // the zone pointers - they are different address spaces - and the error compounded
  // until a disk's chains sat 27,000 bytes below the arena and two programs shared a
  // record. Deriving the layout cannot drift.

  Disk.prototype.programsInOrder = function () {
    return this.entries.filter(function (e) { return e.type === 'P'; })
                       .sort(function (a, b) { return a.slot - b.slot; });
  };

  Disk.prototype.totalKeygroups = function () {
    var self = this, n = 0;
    this.programsInOrder().forEach(function (p) { n += self.keygroupCount(p); });
    return n;
  };

  /**
   * Where the arena starts. Not stored anywhere, so it is read back from the zone
   * pointers, which are the ones the sampler actually follows. Captured when the disk
   * loads, because the counts it is derived from change as soon as anything is edited.
   */
  Disk.prototype.deriveArenaBase = function () {
    var self = this;
    function sane(v) { return v > 0 && v < SAMPLE_RAM_BASE ? v : null; }

    // Best evidence: the zone pointers, which are the ones the sampler follows.
    var table = this.sampleTableBase();
    if (table !== null) {
      var fromZones = sane(table -
        KEYGROUP * (this.totalKeygroups() + this.programsInOrder().length - 1));
      if (fromZones !== null) return fromZones;
    }

    // A disk of programs with no samples has no zone pointers at all, so fall back to
    // the chain pointers - by majority, so one damaged program cannot carry the vote.
    var lay = this.arenaLayout(), votes = {}, best = null;
    this.programsInOrder().forEach(function (p) {
      if (self.keygroupCount(p) < 2) return;
      var v = sane(chainOf(self.readFile(p), 0) - KEYGROUP * (lay.first[p.slot] + 1));
      if (v === null) return;
      votes[v] = (votes[v] || 0) + 1;
      if (best === null || votes[v] > votes[best]) best = v;
    });
    if (best !== null) return Number(best);

    return ARENA_DEFAULT;
  };

  Disk.prototype.arenaBase = function () {
    if (this._arenaBase === undefined) this._arenaBase = this.deriveArenaBase();
    return this._arenaBase;
  };

  /** The first record index of each program, keyed by directory slot. */
  Disk.prototype.arenaLayout = function () {
    var self = this, at = {}, rec = 0;
    this.programsInOrder().forEach(function (p) {
      at[p.slot] = rec;
      rec += self.keygroupCount(p) + 1;          // one empty record between programs
    });
    return { first: at, records: Math.max(0, rec - 1) };
  };

  /** Where the sample descriptor table begins, derived rather than guessed. */
  Disk.prototype.sampleTableAddress = function () {
    return this.arenaBase() + KEYGROUP * this.arenaLayout().records;
  };

  /**
   * Rewrite every keygroup chain pointer and every zone pointer from the layout above.
   * Call after anything that changes the number of programs, keygroups or samples.
   */
  Disk.prototype.rebuildPointers = function () {
    var self = this, arena = this.arenaBase(), lay = this.arenaLayout();
    var table = arena + KEYGROUP * lay.records;
    var chains = 0, zones = 0, headers = 0;

    this.programsInOrder().forEach(function (p) {
      var count = self.keygroupCount(p), start = lay.first[p.slot];
      var raw = self.readFile(p);

      // The program header restates two things the rest of the file already implies:
      // where its keygroups load (18..19) and how many there are (23). The sampler
      // believes the header, so a stale count silently drops keygroups and a stale
      // load address drops one program's records on top of another's.
      var load = arena + KEYGROUP * start;
      if (raw.length > 19 && (raw[18] | (raw[19] << 8)) !== load) {
        self.pokeFile(p, 18, load & 0xFF);
        self.pokeFile(p, 19, (load >> 8) & 0xFF);
        headers++;
      }
      if (raw.length > 23 && raw[23] !== count) {
        self.pokeFile(p, 23, count & 0xFF);
        headers++;
      }

      for (var k = 0; k < count; k++) {
        var kg = PROG_HEADER + k * KEYGROUP;

        var co = kg + KG_CHAIN;
        var want = (k === count - 1) ? 0 : arena + KEYGROUP * (start + k + 1);
        if (co + 1 < raw.length && (raw[co] | (raw[co + 1] << 8)) !== want) {
          self.pokeFile(p, co, want & 0xFF);
          self.pokeFile(p, co + 1, (want >> 8) & 0xFF);
          chains++;
        }

        for (var z = 0; z < 2; z++) {
          var no = kg + KG_NAME + z * KG_ZONE_STRIDE, po = no + 16;
          if (po + 1 >= raw.length) continue;

          var name = cleanName(raw, no).trim();
          var have = raw[po] | (raw[po + 1] << 8);
          if (!name || name === '2 SAMPLE' || !have) continue;

          var i = self.sampleIndex(name);
          if (i < 0) continue;                   // names a sample that is not here

          var wantZ = table + KEYGROUP * i;
          if (have !== wantZ) {
            self.pokeFile(p, po, wantZ & 0xFF);
            self.pokeFile(p, po + 1, (wantZ >> 8) & 0xFF);
            zones++;
          }
        }
      }
    });

    if (chains || zones || headers) this.modified = true;
    return { chains: chains, zones: zones, headers: headers };
  };

  Disk.prototype.keygroupArenaBase = function (program) {
    var raw = this.readFile(program);
    if (this.keygroupCount(program) >= 2) {
      var first = chainOf(raw, 0);
      if (first >= KEYGROUP) return first - KEYGROUP;
    }

    var prev = null, self = this;
    this.entries.forEach(function (p) {
      if (p.type === 'P' && p.slot < program.slot && (!prev || p.slot > prev.slot)) prev = p;
    });

    if (prev && this.keygroupCount(prev) >= 2) {
      var b = chainOf(this.readFile(prev), 0) - KEYGROUP;
      if (b > 0) return b + KEYGROUP * (this.keygroupCount(prev) + 1);
    }
    return 0xC5F6;
  };

  /** Each record points at the next, 70 bytes on; the last holds zero. */
  function relink(file, count, base) {
    for (var i = 0; i < count; i++)
      putU16(file, PROG_HEADER + i * KEYGROUP + KG_CHAIN,
             i === count - 1 ? 0 : base + KEYGROUP * (i + 1));
  }

  /**
   * Keygroup records and sample descriptors share one RAM arena in directory order,
   * so a program changing size moves everything above it.
   */
  Disk.prototype.shiftKeygroupArena = function (above, delta, exceptSlot) {
    var moved = 0, self = this;

    this.entries.forEach(function (p) {
      if (p.type !== 'P') return;
      var count = self.keygroupCount(p);
      var raw = self.readFile(p);

      for (var k = 0; k < count; k++) {
        var kg = PROG_HEADER + k * KEYGROUP;

        if (p.slot !== exceptSlot) {
          var o = kg + KG_CHAIN;
          if (o + 1 < raw.length) {
            var v = raw[o] | (raw[o + 1] << 8);
            if (v > above) { self.pokeFile(p, o, (v + delta) & 0xFF);
                             self.pokeFile(p, o + 1, ((v + delta) >> 8) & 0xFF); moved++; }
          }
        }
        for (var z = 0; z < 2; z++) {
          var po = kg + ZONE_PTR + z * KG_ZONE_STRIDE;
          if (po + 1 >= raw.length) continue;
          var pv = raw[po] | (raw[po + 1] << 8);
          if (pv > above) { self.pokeFile(p, po, (pv + delta) & 0xFF);
                            self.pokeFile(p, po + 1, ((pv + delta) >> 8) & 0xFF); moved++; }
        }
      }
    });
    return moved;
  };

  /** Adds a keygroup, seeded from an existing one so it arrives playable. */
  Disk.prototype.addKeygroup = function (program, copyFrom) {
    var count = this.keygroupCount(program);
    if (count >= MAX_KEYGROUPS)
      throw new Error('A program can hold at most ' + MAX_KEYGROUPS + ' keygroups.');

    var data = this.readFile(program);
    var base = this.keygroupArenaBase(program);

    var bigger = new Uint8Array(data.length + KEYGROUP);
    bigger.set(data, 0);

    var src = PROG_HEADER + Math.max(0, Math.min(count - 1, copyFrom)) * KEYGROUP;
    bigger.set(data.subarray(src, src + KEYGROUP), PROG_HEADER + count * KEYGROUP);

    relink(bigger, count + 1, base);
    this.resizeFile(program, bigger);

    this.modified = true;
    this.parseDirectory();
    this.rebuildPointers();     // an extra keygroup moves the sample table, so every
    this.parseDirectory();      // zone pointer past it changes too
    return count + 1;
  };

  Disk.prototype.deleteKeygroup = function (program, index) {
    var count = this.keygroupCount(program);
    if (count <= 1) throw new Error('A program must keep at least one keygroup.');
    if (index < 0 || index >= count) throw new Error('no such keygroup');

    var data = this.readFile(program);
    var base = this.keygroupArenaBase(program);

    var smaller = new Uint8Array(data.length - KEYGROUP);
    var cut = PROG_HEADER + index * KEYGROUP;
    smaller.set(data.subarray(0, cut), 0);
    smaller.set(data.subarray(cut + KEYGROUP), cut);

    relink(smaller, count - 1, base);
    this.resizeFile(program, smaller);

    this.modified = true;
    this.parseDirectory();
    this.rebuildPointers();
    this.parseDirectory();
    return count - 1;
  };

  /** Write one byte of a keygroup record. Offsets are as listed in format section 7.2. */
  Disk.prototype.setKeygroupByte = function (program, index, offset, value) {
    if (index < 0 || index >= this.keygroupCount(program)) return;
    this.pokeFile(program, PROG_HEADER + index * KEYGROUP + offset, value);
  };

  /**
   * The pointer a keygroup zone uses to refer to a sample. It is an index into a
   * table of 70-byte descriptors in the sampler's RAM, in directory order - not the
   * sample's audio address - so it is learned from the zones already on the disk and
   * extrapolated for samples no program mentions yet.
   */
  /** Samples in directory order, which is the order of the descriptor table. */
  Disk.prototype.samplesInOrder = function () {
    return this.entries.filter(function (e) { return e.type === 'S'; })
                       .sort(function (a, b) { return a.slot - b.slot; });
  };

  Disk.prototype.sampleIndex = function (name) {
    var want = (name || '').trim().toUpperCase();
    var samples = this.samplesInOrder();
    for (var i = 0; i < samples.length; i++)
      if (samples[i].name.trim().toUpperCase() === want) return i;
    return -1;
  };

  /**
   * Where the sample descriptor table starts, taken as the answer most of the
   * zones agree on. Every zone pointer is base + 70 x the sample's position, so
   * each one implies a base; a zone left over from an earlier arrangement implies
   * the wrong one, and would poison an answer taken from a single zone.
   */
  Disk.prototype.sampleTableBase = function () {
    var self = this, votes = {}, best = null, bestCount = 0;

    this.entries.forEach(function (p) {
      if (p.type !== 'P') return;
      self.keygroups(p).forEach(function (kg) {
        [kg.zone1, kg.zone2].forEach(function (z) {
          if (!z.inUse || !z.pointer) return;
          var i = self.sampleIndex(z.name);
          if (i < 0) return;

          var base = z.pointer - KEYGROUP * i;
          votes[base] = (votes[base] || 0) + 1;
          if (votes[base] > bestCount) { bestCount = votes[base]; best = base; }
        });
      });
    });
    return best;
  };

  /** The pointer a zone should carry to refer to a sample. */
  Disk.prototype.sampleReference = function (name) {
    var i = this.sampleIndex(name);
    if (i < 0) return 0;

    return this.sampleTableAddress() + KEYGROUP * i;
  };

  /**
   * Rewrites every zone pointer from the sample's current position. Adding and
   * deleting samples moves those positions, and a pointer left behind refers to
   * the wrong descriptor - or, after enough deletions, to one before the table
   * begins. Returns how many were wrong.
   */
  Disk.prototype.repairZonePointers = function () {
    var base = this.sampleTableAddress();
    if (base === null) return 0;

    var self = this, fixed = 0;
    this.entries.forEach(function (p) {
      if (p.type !== 'P') return;

      self.keygroups(p).forEach(function (kg, k) {
        [kg.zone1, kg.zone2].forEach(function (z, zi) {
          if (!z.inUse) return;
          var i = self.sampleIndex(z.name);
          if (i < 0) return;

          var want = base + KEYGROUP * i;
          if (z.pointer === want) return;

          var off = PROG_HEADER + k * KEYGROUP + KG_NAME + zi * KG_ZONE_STRIDE + 16;
          self.pokeFile(p, off, want & 0xFF);
          self.pokeFile(p, off + 1, (want >> 8) & 0xFF);
          fixed++;
        });
      });
    });
    if (fixed) this.modified = true;
    return fixed;
  };

  /** Puts a zero terminator back on any keygroup chain missing one. */
  /** Kept for the checkers: the whole arena is rebuilt from its layout. */
  Disk.prototype.repairKeygroupChains = function () {
    return this.rebuildPointers().chains;
  };

  /** Points a keygroup zone at a sample: its name, and the pointer that goes with it. */
  // ------------------------------------------------------- programs: add/delete
  //
  // A program file is a 38-byte header and one or more 70-byte keygroups. Rather than
  // invent one, these templates are the byte-by-byte mode of the library's 388 programs
  // and 1902 keygroups, so a program this tool creates is indistinguishable from one the
  // Akai wrote except in the fields that must differ.

  var PROGRAM_TEMPLATE = [
    67, 79, 77, 32, 32, 32, 32, 32, 32, 32, 0, 32, 32, 32, 32, 32, 0, 0, 246, 197,
    0, 0, 255, 1, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
  ];

  var KEYGROUP_TEMPLATE = [
    127, 24, 128, 0, 80, 99, 30, 10, 50, 0, 0, 30, 0, 0, 99, 64, 64, 0, 4, 255,
    0, 0, 50, 0, 84, 79, 78, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32,
    0, 211, 0, 0, 99, 0, 50, 32, 83, 65, 77, 80, 76, 69, 32, 32, 32, 32, 32, 32,
    32, 32, 0, 0, 0, 0, 99, 0, 0, 0
  ];

  /**
   * Open a gap at `slot`, shifting every entry above it up one place.
   *
   * Programs come before the overall settings, the drum set and the samples - 98 of the
   * 100 library disks are exactly that order - so a new program cannot simply be appended
   * to the end of the directory. Relative order is preserved, so sample positions, and
   * with them the zone pointers, are unaffected.
   */
  Disk.prototype.makeRoomAt = function (slot) {
    if (this.freeSlots() < 1) throw new Error('The directory is full: 64 files is the limit.');

    for (var i = DIR_ENTRIES - 1; i > slot; i--) {
      var to = DIR_OFF + i * ENTRY, from = DIR_OFF + (i - 1) * ENTRY;
      this.image.copyWithin(to, from, from + ENTRY);
    }
    this.image.fill(0, DIR_OFF + slot * ENTRY, DIR_OFF + (slot + 1) * ENTRY);

    this.modified = true;
    this.parseDirectory();
  };

  /** The lowest MIDI program number no program on this disk is using. */
  Disk.prototype.freeProgramNumber = function () {
    var taken = {}, self = this;
    this.programsInOrder().forEach(function (p) {
      var raw = self.readFile(p);
      if (raw.length > 26) taken[raw[26]] = true;
    });
    for (var n = 0; n < 128; n++) if (!taken[n]) return n;
    return 0;
  };

  /**
   * A new program holding one empty keygroup across the whole keyboard. It is placed
   * after the last program, before everything else, and the arena is rebuilt around it.
   */
  Disk.prototype.addProgram = function (name, opts) {
    opts = opts || {};

    var body = new Uint8Array(PROG_HEADER + KEYGROUP);
    body.set(PROGRAM_TEMPLATE, 0);
    body.set(KEYGROUP_TEMPLATE, PROG_HEADER);

    // The file repeats its own name in bytes 0..9, and it is that copy the S950 puts on
    // the display - not the directory entry. A program named only in the directory shows
    // whatever the template happened to carry. The library agrees: 383 of its 388 programs
    // and all 1104 samples hold the same name in both places, and the five exceptions
    // differ only by leading spaces.
    var clean = normaliseName(name);
    for (var i = 0; i < 10; i++) body[i] = i < clean.length ? clean.charCodeAt(i) : 32;

    body[23] = 1;                                  // one keygroup
    body[26] = opts.programNumber === undefined ? this.freeProgramNumber()
                                                : opts.programNumber & 0x7F;

    var kg = PROG_HEADER;
    body[kg + 0] = opts.highKey === undefined ? 127 : opts.highKey;   // high key
    body[kg + 1] = opts.lowKey === undefined ? 0 : opts.lowKey;       // low key
    putU16(body, kg + KG_CHAIN, 0);                                   // the only keygroup

    // Both zones empty. '2 SAMPLE' with a zero pointer is how the library marks an
    // unused zone, and it is what clearZone writes.
    for (var z = 0; z < 2; z++) {
      var at = kg + KG_NAME + z * KG_ZONE_STRIDE;
      var placeholder = '2 SAMPLE';
      for (var i = 0; i < 10; i++)
        body[at + i] = i < placeholder.length ? placeholder.charCodeAt(i) : 32;
      putU16(body, at + 16, 0);
    }

    // after the last program, so the P / O / D / S grouping survives
    var progs = this.programsInOrder();
    var at = progs.length ? progs[progs.length - 1].slot + 1 : 0;

    if (at < this.entries.length) this.makeRoomAt(at);

    var e = this.addFile(clean, 'P', body, at);

    this.parseDirectory();
    this.rebuildPointers();       // one more program moves the sample table
    this.parseDirectory();

    return this.entryInSlot(e.slot);
  };

  /**
   * Remove a program. Nothing on a disk refers to a program - the drum set's voice
   * indexes are just 0..7, and no field anywhere holds a program address - so this only
   * has to free the blocks, close the directory and rebuild the arena around one fewer
   * program.
   */
  Disk.prototype.deleteProgram = function (e) {
    if (!e || e.type !== 'P') throw new Error('not a program');

    var self = this;
    var chain = this.chain(e.startBlock);
    chain.forEach(function (b) { self.setFat(b, 0); });

    var d = DIR_OFF + e.slot * ENTRY;
    this.image.fill(0, d, d + ENTRY);

    this.modified = true;
    this.compactDirectory();
    this.parseDirectory();
    this.rebuildPointers();       // one fewer program moves the sample table
    this.parseDirectory();

    return { blocksFreed: chain.length };
  };

  // ------------------------------------------------------------------ slicing
  //
  // Cutting one complex sample into a run of one-shots. This is the first operation that
  // can exhaust three different limits at once - directory slots, disk blocks and the
  // sampler's own memory - so the whole plan is worked out and reported before anything
  // is written.

  /** How much sampler memory the samples on this disk occupy, in bytes. */
  Disk.prototype.sampleMemoryUsed = function () {
    var S = this.samplesInOrder();
    if (!S.length) return 0;
    var last = S[S.length - 1];
    return last.memoryAddress + ramSize(last.sampleCount) - SAMPLE_RAM_BASE;
  };

  /** Directory slots not yet spoken for. */
  Disk.prototype.freeSlots = function () {
    var used = 0;
    for (var i = 0; i < DIR_ENTRIES; i++)
      if (this.image[DIR_OFF + i * ENTRY] !== 0) used++;
    return DIR_ENTRIES - used;
  };

  /**
   * Names for a run of slices. Ten characters is the hard limit, so the stem is cut short
   * to leave room for the number, and a letter is added if that collides with a sample
   * already here - names must be unique within a type.
   */
  Disk.prototype.sliceNames = function (base, count) {
    var digits = String(count).length;
    var taken = {};
    this.entries.forEach(function (e) {
      if (e.type === 'S') taken[e.name.trim().toUpperCase()] = true;
    });

    for (var attempt = 0; attempt < 27; attempt++) {
      var mark = attempt ? String.fromCharCode(96 + attempt) : '';     // '', a, b, c...
      var room = 10 - digits - 1 - mark.length;
      var stem = normaliseName(base).slice(0, Math.max(1, room)).replace(/ +$/, '');

      var names = [], clash = false;
      for (var i = 1; i <= count; i++) {
        var num = String(i);
        while (num.length < digits) num = '0' + num;

        var n = stem + mark + ' ' + num;
        if (taken[n.toUpperCase()]) { clash = true; break; }
        names.push(n);
      }
      if (!clash) return names;
    }
    throw new Error('Could not find unused names for ' + count + ' slices.');
  };

  /**
   * What slicing would cost. Changes nothing; show this before committing to it.
   * `cuts` are slice starts in words, `opts.maxRam` the sampler's memory in bytes.
   */
  Disk.prototype.planSlices = function (e, cuts, opts) {
    opts = opts || {};
    var maxRam = opts.maxRam || DEFAULT_SAMPLER_RAM;
    var words = this.sampleWords12(e);

    var starts = (cuts || []).slice().sort(function (a, b) { return a - b; });
    var slices = [], blocks = 0, ram = 0;

    for (var i = 0; i < starts.length; i++) {
      var from = Math.max(0, starts[i]) & ~1;
      var to = (i + 1 < starts.length ? starts[i + 1] : words.length) & ~1;
      var n = to - from;
      if (n < 2) continue;

      slices.push({ start: from, end: to, count: n });
      blocks += blocksFor(60 + 1.5 * n);
      ram += ramSize(n);
    }

    var problems = [];
    if (slices.length < 2) problems.push('Fewer than two slices - nothing to cut.');

    if (slices.length > this.freeSlots())
      problems.push(slices.length + ' slices need that many directory slots, but only ' +
                    this.freeSlots() + ' of ' + DIR_ENTRIES + ' are free.');

    if (blocks > this.freeBlocks())
      problems.push('Needs ' + blocks + ' blocks, ' + this.freeBlocks() + ' free on the disk.');

    var spare = maxRam - this.sampleMemoryUsed();
    if (ram > spare)
      problems.push('Needs ' + Math.round(ram / 1024) + ' KB of sampler memory, ' +
                    Math.round(spare / 1024) + ' KB free of ' + Math.round(maxRam / 1024) + ' KB.');

    if (opts.program) {
      var have = this.keygroupCount(opts.program);
      if (have + slices.length > MAX_KEYGROUPS)
        problems.push(opts.program.name.trim() + ' has ' + have + ' keygroups; ' +
                      slices.length + ' more would pass the limit of ' + MAX_KEYGROUPS + '.');
    }

    var names = [];
    if (slices.length >= 2) {
      try { names = this.sliceNames(opts.name || e.name, slices.length); }
      catch (err) { problems.push(err.message); }
    }
    slices.forEach(function (s, i) { s.name = names[i] || ''; });

    return {
      slices: slices, slots: slices.length, blocks: blocks, ram: ram,
      spare: spare, problems: problems, ok: problems.length === 0
    };
  };

  /**
   * Cut the sample into one-shots, leaving the original alone. With `opts.program`, one
   * keygroup per slice is appended from `opts.rootKey` upward, and each slice is tuned to
   * the key it sits on so pressing that key plays it at the rate it was recorded.
   */
  Disk.prototype.sliceSample = function (e, cuts, opts) {
    opts = opts || {};

    var plan = this.planSlices(e, cuts, opts);
    if (!plan.ok) throw new Error(plan.problems.join(' '));

    var words = this.sampleWords12(e);
    var rate = e.sampleRate;
    var root = opts.rootKey === undefined ? 60 : opts.rootKey;
    var progSlot = opts.program ? opts.program.slot : -1;
    var self = this, added = [];

    plan.slices.forEach(function (s, i) {
      var key = clampKey(root + i);
      self.addSample(s.name, words.subarray(s.start, s.end), rate, key, 0, 'O');
      added.push(s.name);
    });

    // Adding samples reparses, so the program entry has to be found again each time.
    var mapped = 0;
    if (progSlot >= 0) {
      for (var i = 0; i < added.length; i++) {
        var program = this.entryInSlot(progSlot);
        if (!program) break;

        var at = this.addKeygroup(program, this.keygroupCount(program) - 1) - 1;
        program = this.entryInSlot(progSlot);
        if (!program) break;

        this.setKeygroupByte(program, at, 0, clampKey(root + i));   // high key
        this.setKeygroupByte(program, at, 1, clampKey(root + i));   // low key
        this.setZoneSample(program, at, 0, added[i]);

        // The new keygroup was seeded from an existing one, which may have carried a
        // second zone. A slice plays one sample on one key.
        this.clearZone(program, at, 1);
        mapped++;
      }
    }

    this.parseDirectory();
    this.rebuildPointers();
    this.parseDirectory();

    return { added: added, keygroups: mapped, rootKey: root };
  };

  Disk.prototype.entryInSlot = function (slot) {
    for (var i = 0; i < this.entries.length; i++)
      if (this.entries[i].slot === slot) return this.entries[i];
    return null;
  };

  function clampKey(k) { return k < 0 ? 0 : k > 127 ? 127 : k; }

  Disk.prototype.setZoneSample = function (program, index, zone, name) {
    var clean = normaliseName(name);
    var base = PROG_HEADER + index * KEYGROUP + KG_NAME + zone * KG_ZONE_STRIDE;

    for (var i = 0; i < 10; i++)
      this.pokeFile(program, base + i, i < clean.length ? clean.charCodeAt(i) : 32);

    var ptr = this.sampleReference(clean);
    this.pokeFile(program, base + 16, ptr & 0xFF);
    this.pokeFile(program, base + 17, (ptr >> 8) & 0xFF);
  };

  /** Clears a zone, which is how the S950 marks one unused. */
  Disk.prototype.clearZone = function (program, index, zone) {
    var base = PROG_HEADER + index * KEYGROUP + KG_NAME + zone * KG_ZONE_STRIDE;
    var placeholder = '2 SAMPLE';
    for (var i = 0; i < 10; i++)
      this.pokeFile(program, base + i, i < placeholder.length ? placeholder.charCodeAt(i) : 32);
    this.pokeFile(program, base + 16, 0);
    this.pokeFile(program, base + 17, 0);
  };

  /** Rebuild the image file, ready to download. */
  /**
   * The image to write out, in either container.
   *
   *   img - the 800K sector image as the sampler sees it. Always available: it is
   *         exactly the bytes this object has been editing. FlashFloppy reads these.
   *   hfe - the Gotek/HxC container, rebuilt by patching the sectors of the HFE this
   *         disk was loaded from. That template is what carries the MFM bitstream,
   *         gaps and sync marks, so a disk opened from a raw .img cannot be written
   *         as HFE - there is nothing to patch and no encoder to synthesise a track
   *         from nothing. canSave() says so before the user commits to a name.
   */
  Disk.prototype.save = function (format) {
    var want = format || (this.isHfe ? 'hfe' : 'img');

    if (want === 'img') return new Uint8Array(this.image);

    if (want !== 'hfe') throw new Error('unknown format "' + want + '"');

    // With the HFE it came from, patch that: its bitstream, gaps and any quirks of the
    // drive that wrote it are preserved. Without one, synthesise the whole container.
    return (this.isHfe && this.rawHfe)
      ? rebuild(this.rawHfe, this.image)
      : buildHfe(this.image, this.totalBlocks() / (SPT * 2), 2);
  };

  /** Whether this disk can be written in the given container. */
  /** Both containers can always be written now that an HFE can be built from nothing. */
  Disk.prototype.canSave = function (format) {
    return format === 'img' || format === 'hfe';
  };

  /** Read a .hfe or a raw sector image. */
  function load(name, bytes) {
    var raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    var isHfe = raw.length > 8 &&
      String.fromCharCode.apply(null, raw.subarray(0, 8)) === 'HXCPICFE';

    if (isHfe) {
      var r = extract(raw);
      return new Disk(name, r.image, raw, true, r.badCrc, r.missing);
    }
    if (raw.length === 819200 || raw.length === 1638400) {
      return new Disk(name, raw, raw, false, 0, 0);
    }
    throw new Error('Not an HFE image or an 800K/1600K raw image.');
  }

  return {
    load: load,
    extract: extract,
    rebuild: rebuild,
    sideCells: sideCells,
    unpack: unpack,
    pack: pack,
    scanBits: scanBits,
    patchField: patchField,
    packSampleData: packSampleData,
    normaliseName: normaliseName,
    blocksFor: blocksFor,
    noteName: noteName,
    BLOCK: BLOCK,
    HEADER: HEADER,
    MAX_KEYGROUPS: MAX_KEYGROUPS
  };
})();

// Shown in the page header. Bump it with any change to the write path, so a browser
// running a cached copy is obvious at a glance rather than after a ruined disk.
Akai.BUILD = '2026-09-20d';

if (typeof module !== 'undefined' && module.exports) module.exports = Akai;

