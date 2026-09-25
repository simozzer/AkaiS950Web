/*
 * What changed between two disk images, byte by byte.
 *
 *   node tools/kgdiff.js before.hfe after.hfe
 *   node tools/kgdiff.js before.hfe after.hfe --all      include bytes we already know
 *
 * For answering "what does this control on the panel actually write?".
 *
 * Save a programme, change ONE thing on the sampler, save it again to a second disk, and run
 * this. It names every byte that moved, says which keygroup and which offset, and tells you
 * whether that offset already has a meaning - so a control nobody has identified shows up as
 * a change at an offset with no name against it.
 *
 * This is how the positional crossfade and key-to-loudness fields were pinned down, done by
 * hand at the time. The velocity page's ON/OFF next to Release is the next one, and the
 * keygroup record still has thirteen bytes and five flag bits with no known meaning:
 *
 *     bytes  12, 13, 14, 19, 20, 38, 39, 56, 57, 58, 59, 60, 61
 *     bits   0x02, 0x10, 0x20, 0x40, 0x80 of byte 18
 *
 * An on/off is one bit or one byte, so it is almost certainly among those - and the three
 * sitting directly after the velocity block, 12 to 14, are the first place to look.
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');

var args = process.argv.slice(2);
var all = args.indexOf('--all') >= 0;
args = args.filter(function (a) { return a !== '--all'; });

if (args.length < 2) {
  console.log('');
  console.log('usage: node tools/kgdiff.js <before.hfe> <after.hfe> [--all]');
  console.log('');
  console.log('  Save a programme, change one control on the panel, save again, and diff.');
  console.log('');
  process.exit(1);
}

function open(p) {
  return Akai.load(path.basename(p), new Uint8Array(fs.readFileSync(p)));
}

/*
 * What each offset in a 70-byte keygroup record is known to be.
 *
 * Anything absent is a byte nobody has explained, and those are the interesting ones - so an
 * unnamed offset is shouted about rather than listed quietly.
 */
function keygroupMap() {
  var m = {
    0: 'high key', 1: 'low key', 2: 'velocity switch',
    3: 'VCA attack', 4: 'VCA decay', 5: 'VCA sustain', 6: 'VCA release',
    7: 'vel->filter', 8: 'key->filter', 9: 'vel->attack', 10: 'vel->release',
    11: 'vel->loudness',
    15: 'LFO delay', 16: 'LFO rate', 17: 'LFO depth', 18: 'flags',
    21: 'LFO->aftertouch', 22: 'LFO->wheel', 23: 'VCF amount',
    34: 'VCF attack', 35: 'VCF decay', 36: 'VCF sustain', 37: 'VCF release',
    43: 'transpose', 68: 'next keygroup', 69: 'next keygroup'
  };

  for (var z = 0; z < 2; z++) {
    var b = 24 + z * 22, who = 'zone ' + (z + 1) + ' ';
    for (var i = 0; i < 10; i++) m[b + i] = who + 'name';
    m[b + 16] = m[b + 17] = who + 'pointer';
    m[b + 18] = who + 'fine';
    m[b + 19] = who + 'transpose';
    m[b + 20] = who + 'filter';
    m[b + 21] = who + 'loudness';
  }
  return m;
}

/*
 * The program header's own 38 bytes, as far as anyone has worked them out.
 *
 * Bytes 18 and 19 were identified by this tool on its first real use: they moved by exactly
 * the same amount as every zone and next-keygroup pointer in the file when the sampler
 * rewrote it - 376 bytes down, twelve fields, one delta - so they are an address of the same
 * kind and not a setting.
 */
var HEADER_MAP = {
  0: 'program number', 16: 'key->loudness', 17: 'key->loudness',
  18: 'program pointer', 19: 'program pointer',
  21: 'positional crossfade', 22: 'format marker (S900/S950)'
};

var KG_MAP = keygroupMap();
var PROG_HEADER = 38, KEYGROUP = 70;

/// The eight bits of a byte, named where the meaning is known.
var FLAG_BITS = { 0x01: 'constant pitch', 0x04: 'LFO desync', 0x08: 'one-shot' };

function bitsChanged(before, after) {
  var out = [];
  for (var b = 0; b < 8; b++) {
    var mask = 1 << b;
    if (((before ^ after) & mask) === 0) continue;
    out.push('0x' + mask.toString(16).padStart(2, '0') + ' ' +
             ((after & mask) ? 'set' : 'cleared') +
             '  ' + (FLAG_BITS[mask] || '*** NO KNOWN MEANING ***'));
  }
  return out;
}

var a = open(args[0]), b = open(args[1]);

console.log('');
console.log('  ' + path.basename(args[0]) + '   ->   ' + path.basename(args[1]));

var names = {};
[a, b].forEach(function (d) {
  d.programsInOrder().forEach(function (p) { names[p.name.trim()] = true; });
});

var moved = 0, unexplained = 0;

Object.keys(names).forEach(function (name) {
  var pa = null, pb = null;
  a.programsInOrder().forEach(function (p) { if (p.name.trim() === name) pa = p; });
  b.programsInOrder().forEach(function (p) { if (p.name.trim() === name) pb = p; });

  if (!pa || !pb) {
    console.log('');
    console.log('  ' + name + ': only on ' + (pa ? 'the first' : 'the second') + ' disk');
    return;
  }

  var ra = a.readFile(pa), rb = b.readFile(pb);
  var said = false;

  /*
   * Every pointer in the file moves when the sampler reloads the programme somewhere else,
   * and they all move by the SAME amount - they are RAM addresses, not settings.
   *
   * On the first real use of this tool that was twelve fields shifting by 376 bytes apiece,
   * and the single bit that had actually been changed on the panel was buried in the middle
   * of them. So a uniform shift is recognised, stated once, and the bytes carrying it are
   * left out of everything below. A pointer that does NOT match the shift stays in, because
   * that would be a real difference rather than a relocation.
   */
  var pointerAt = [{ what: 'header', off: 18 }];
  var kgCount = Math.min(a.keygroupCount(pa), b.keygroupCount(pb));

  for (var pk = 0; pk < kgCount; pk++) {
    var po = PROG_HEADER + pk * KEYGROUP;
    pointerAt.push({ what: 'kg ' + (pk + 1) + ' zone 1', off: po + 40 },
                   { what: 'kg ' + (pk + 1) + ' zone 2', off: po + 62 },
                   { what: 'kg ' + (pk + 1) + ' next',   off: po + 68 });
  }

  function u16 (r, o) { return r[o] | (r[o + 1] << 8); }

  var shifts = {}, shifted = 0;
  pointerAt.forEach(function (p) {
    if (p.off + 1 >= ra.length || p.off + 1 >= rb.length) return;
    var d = u16 (rb, p.off) - u16 (ra, p.off);
    if (d === 0) return;
    shifts[d] = (shifts[d] || 0) + 1;
    shifted++;
  });

  var keys = Object.keys (shifts);
  var relocated = {};

  if (keys.length === 1 && shifted > 1) {
    var by = Number (keys[0]);
    console.log('');
    console.log('  ' + name);
    said = true;
    console.log('    ' + shifted + ' pointers all moved by ' + by + ' - the programme was ' +
                'reloaded to a different address,');
    console.log('    which is the sampler housekeeping rather than anything you changed. ' +
                'Ignoring them.');

    pointerAt.forEach(function (p) {
      if (p.off + 1 >= ra.length || p.off + 1 >= rb.length) return;
      if (u16 (rb, p.off) - u16 (ra, p.off) !== by) return;
      relocated[p.off] = relocated[p.off + 1] = true;
    });
  }

  function report(where, off, was, now, what) {
    if (!said) { console.log(''); console.log('  ' + name); said = true; }
    moved++;

    var known = what !== undefined;
    if (!known) unexplained++;

    console.log('    ' + where + ' byte ' + String(off).padStart(2) + '   ' +
                String(was).padStart(3) + ' -> ' + String(now).padStart(3) + '   ' +
                (known ? what : '*** NO KNOWN MEANING ***'));

    /*
     * Broken into bits only where a bit is what it would mean.
     *
     * The flags byte of a keygroup always, and any byte where exactly one bit moved. NOT a
     * header byte, which has its own meanings - the first version ran the keygroup's flag
     * names over header bytes 18 and 19 and confidently reported "one-shot" and "constant
     * pitch" on what turned out to be half a pointer.
     */
    var diff = was ^ now;
    if ((where.indexOf('kg') === 0 && off === 18) ||
        (where.indexOf('kg') === 0 && diff && (diff & (diff - 1)) === 0))
      bitsChanged(was, now).forEach(function (line) {
        console.log('        bit ' + line);

        // a bit nobody has explained counts as a find, even inside a byte we do understand
        if (known && line.indexOf('NO KNOWN MEANING') >= 0) unexplained++;
      });
  }

  for (var i = 0; i < PROG_HEADER && i < ra.length && i < rb.length; i++)
    if (relocated[i] && ! all) continue;
    if (ra[i] !== rb[i] && (all || HEADER_MAP[i] === undefined))
      report('header ', i, ra[i], rb[i], HEADER_MAP[i]);

  for (var k = 0; k < kgCount; k++) {
    var oa = PROG_HEADER + k * KEYGROUP;
    for (var j = 0; j < KEYGROUP; j++) {
      if (oa + j >= ra.length || oa + j >= rb.length) break;
      if (relocated[oa + j] && ! all) continue;
      if (ra[oa + j] === rb[oa + j]) continue;

      /*
       * The flags byte is named, but only three of its eight bits are.
       *
       * Filtering it out as "already known" would hide exactly the thing this tool is for:
       * an on/off on the panel is one bit, and five of byte 18's bits have no meaning
       * against them. So it is reported whenever a bit nobody has explained moves, however
       * well the byte itself is understood.
       */
      var unknownBit = false;
      if (j === 18)
        for (var m = 0; m < 8; m++) {
          var mask = 1 << m;
          if (((ra[oa + j] ^ rb[oa + j]) & mask) && !FLAG_BITS[mask]) unknownBit = true;
        }

      if (!all && KG_MAP[j] !== undefined && !unknownBit) continue;

      // The byte is named even when one of its bits is not - the shouting belongs on the
      // bit, which the breakdown below does, rather than on a byte we understand perfectly.
      report('kg ' + String(k + 1).padStart(2) + '  ', j, ra[oa + j], rb[oa + j], KG_MAP[j]);
    }
  }
});

console.log('');
if (moved === 0)
  console.log('  nothing moved' + (all ? '' : ' that is not already understood - try --all'));
else
  console.log('  ' + moved + ' byte(s) changed, ' + unexplained + ' of them unexplained');
console.log('');
