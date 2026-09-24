/*
 * The WAV export, against every sample on every disk in a library.
 *
 * The header is only half of it. The loop has to land exactly where the player puts it,
 * and where it should land is worked out here independently rather than by calling the
 * same code - the two disagreeing is the bug nobody would notice until a DAW looped a
 * sound somewhere the program never did.
 *
 * That matters more than it looks. 37 of the 61 samples in the shipped library declare a
 * loop longer than the sample it belongs to, so the clamping is the common path rather
 * than the edge case, and getting it wrong would be quiet and widespread.
 *
 * The desktop version writes the same file from the same disks, byte for byte - see
 * AkaiS950Tests\WavCheck.cs in the VirtualS950 repository, which is the other half of
 * this pair.
 *
 *   node wavtest.js [directory of .hfe]
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');

var dir = process.argv[2] || '.';
var fails = 0, checks = 0, samples = 0, looping = 0, clamped = 0;
var problems = [];

function check(what, ok) {
  checks++;
  if (!ok) { fails++; problems.push(what); }
}

function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function tagAt(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/** The loop region the player would use, worked out from the entry alone. */
function expectedLoop(e, n) {
  var start = Math.max(0, Math.min(n, e.loopStart || 0));
  var end = (e.loopEnd > 0) ? Math.min(e.loopEnd, n) : n;
  if (end <= start) { start = 0; end = n; }

  var head = end - start;
  var declared = e.loopLength || 0;
  var loopLen = Math.min(declared, head);

  var loops = (e.loopMode === 'L' || e.loopMode === 'A') && declared >= 2 && loopLen >= 2;
  var from = Math.max(0, end - loopLen);
  var to = Math.min(n - 1, end - 1);
  if (to <= from) loops = false;

  return { loops: loops, from: from, to: to };
}

var images = fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); });
if (images.length === 0) {
  console.log('no .hfe images in ' + path.resolve(dir));
  process.exit(1);
}

images.forEach(function (f) {
  var disk;
  try { disk = Akai.load(f, new Uint8Array(fs.readFileSync(path.join(dir, f)))); }
  catch (err) { problems.push(f + ': ' + err.message); fails++; return; }

  disk.entries.forEach(function (e) {
    if (e.type !== 'S') return;

    var words = disk.sampleWords12(e);
    if (words.length === 0) return;
    samples++;
    if (e.loopLength > e.sampleCount) clamped++;

    var who = f.replace(/\.hfe$/i, '') + '/' + e.name.trim();
    var wav = disk.sampleWav(e);

    check(who + ': RIFF', tagAt(wav, 0) === 'RIFF');
    check(who + ': WAVE', tagAt(wav, 8) === 'WAVE');
    check(who + ': RIFF size', u32(wav, 4) === wav.length - 8);

    var at = 12, sawFmt = false, sawData = false, sawSmpl = false, dataBytes = 0;
    var loopStart = 0, loopEnd = 0, loopType = 0, unityNote = 0;

    while (at + 8 <= wav.length) {
      var id = tagAt(wav, at);
      var size = u32(wav, at + 4);
      var body = at + 8;

      if (id === 'fmt ') {
        sawFmt = true;
        check(who + ': PCM', (wav[body] | (wav[body + 1] << 8)) === 1);
        check(who + ': mono', (wav[body + 2] | (wav[body + 3] << 8)) === 1);
        check(who + ': rate', u32(wav, body + 4) === e.sampleRate);
        check(who + ': 16-bit', (wav[body + 14] | (wav[body + 15] << 8)) === 16);
      } else if (id === 'data') {
        sawData = true;
        dataBytes = size;
      } else if (id === 'smpl') {
        sawSmpl = true;
        unityNote = u32(wav, body + 12);
        check(who + ': one loop', u32(wav, body + 28) === 1);
        loopType = u32(wav, body + 36 + 4);
        loopStart = u32(wav, body + 36 + 8);
        loopEnd = u32(wav, body + 36 + 12);
      }

      at = body + size + (size & 1);
    }

    check(who + ': chunks end exactly at EOF', at === wav.length);
    check(who + ': has fmt', sawFmt);
    check(who + ': has data', sawData);
    check(who + ': data holds every sample', dataBytes === words.length * 2);

    var want = expectedLoop(e, words.length);
    check(who + ': smpl present iff it loops', sawSmpl === want.loops);
    if (want.loops) looping++;

    if (sawSmpl && want.loops) {
      check(who + ': loop start (' + want.from + ')', loopStart === want.from);
      check(who + ': loop end (' + want.to + ')', loopEnd === want.to);
      check(who + ': loop inside the audio', loopEnd < words.length);
      check(who + ': type', loopType === (e.loopMode === 'A' ? 1 : 0));
      check(who + ': root note',
            unityNote === Math.max(0, Math.min(127, (e.tuning / 16) | 0)));
    }
  });
});

console.log(images.length + ' disk(s), ' + samples + ' sample(s), ' + looping + ' looping, ' +
            clamped + ' with a loop longer than the sample');
console.log(checks + ' checks, ' + (fails === 0 ? 'ALL PASSED' : fails + ' FAILED'));
problems.slice(0, 15).forEach(function (p) { console.log('  ' + p); });
process.exit(fails === 0 ? 0 : 1);
