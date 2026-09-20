/*
 * What keyToFilter means, measured from three notes.
 *
 * Everything else about the VCF is settled: the shape is exactly a 6th-order Butterworth,
 * and the top of its travel is 0.4 x the sample rate - Akai's own figure, confirmed on
 * hardware. The last assumption is how far the keyboard moves the cutoff, and the library
 * cannot answer it: 74% of keygroups store 50 there and every case where the same sample
 * appears at two key ranges stores 0, so nothing in it compares like with like.
 *
 * WHAT TO RECORD
 *
 *   1. Load the disk carrying the KEYTRAK programme - one keygroup across the whole
 *      keyboard playing NOISE, filter at 50, key->filter at 50, constant pitch on and
 *      nothing else touching the cutoff.
 *   2. In one take, trigger three or four notes a couple of octaves apart - C1, C3, C5
 *      is ideal - leaving a gap of silence between them. Do not touch anything else.
 *
 *   node keycal.js <take.wav> 24,48,72
 *
 * Because the noise is generated here and sits bit-exact in the disk image, its spectrum
 * is known and can simply be divided out: no reference recording is needed, and the level
 * may differ between notes without affecting the answer.
 *
 * It reports how far the cutoff moved per octave of keyboard, which is the tracking
 * fraction at keyToFilter = 50, and prints the CAL.KEY_FULL that follows from it.
 */
var fs = require('fs');
var cal = require('./vcfcal.js');
var Akai = require('./akai.js');

var file = process.argv[2];
var notesArg = process.argv[3];
var image = process.argv[4] || 'DSKA0000-bench.hfe';

if (!file || !notesArg) {
  console.log('usage: node keycal.js <take.wav> <notes, e.g. 24,48,72> [disk image]');
  console.log('see the comment at the top of this file for what to record');
  process.exit(1);
}

var notes = notesArg.split(/[ ,]+/).filter(Boolean).map(Number);
if (notes.length < 2 || notes.some(isNaN)) {
  console.log('give at least two MIDI note numbers, e.g.  24,48,72');
  process.exit(1);
}

// --- the source, exactly as the sampler played it
var disk = Akai.load('x', new Uint8Array(fs.readFileSync(image)));
var smp = null;
disk.entries.forEach(function (e) { if (e.type === 'S' && e.name.trim() === 'NOISE') smp = e; });
if (!smp) { console.log('no NOISE sample in ' + image); process.exit(1); }

var words = disk.sampleWords12(smp);
var source = new Float64Array(words.length);
for (var i = 0; i < words.length; i++) source[i] = words[i] / 2048;

var srcSpec = cal.spectrum(source, smp.sampleRate, cal.BANDS);
console.log('');
console.log('source: NOISE, ' + words.length + ' words at ' + smp.sampleRate + ' Hz');

// --- the take
var w = cal.readWav(file);
var found = cal.splitClips(w.samples, w.rate, notes.length);

if (found.clips.length !== notes.length) {
  console.log('found ' + found.clips.length + ' notes in ' + found.seconds.toFixed(1) +
              's, expected ' + notes.length);
  found.clips.forEach(function (c, i) {
    console.log('    ' + (i + 1) + ': ' + c.seconds[0].toFixed(2) + 's .. ' + c.seconds[1].toFixed(2) + 's');
  });
  if (found.zeroFraction > 0.5)
    console.log('  ' + (found.zeroFraction * 100).toFixed(0) + '% of the file is exact digital ' +
                'zero - the take is probably shorter than the file');
  else
    console.log('  gaps need 150 ms of silence, notes 250 ms of sound');
  process.exit(1);
}

console.log('take  : ' + (w.samples.length / w.rate).toFixed(1) + 's at ' + w.rate +
            ' Hz, ' + found.clips.length + ' notes');
console.log('');
console.log('   note   played at        -3 dB corner');

/**
 * The -3 dB corner of one clip against the known source.
 *
 * The response has to be levelled in the passband first, and which bands count as
 * passband depends on where the corner turns out to be - a fixed window fails exactly
 * where tracking is strongest, because the lowest note's corner can fall inside it and
 * the measurement then levels on the roll-off and reads high. So: find the corner once
 * using only the very bottom of the spectrum, then level again well below that answer
 * and find it properly.
 */
function cornerOf(spec, topHz) {
  var ref = 0, n = 0;
  for (var j = 0; j < cal.BANDS.length; j++)
    if (cal.BANDS[j] < topHz) { ref += spec[j].db - srcSpec[j].db; n++; }

  if (n < 3) {                                   // never fewer than three probes
    ref = 0;
    for (var j = 0; j < 3; j++) ref += spec[j].db - srcSpec[j].db;
    n = 3;
  }
  ref /= n;

  for (var j = 1; j < cal.BANDS.length; j++) {
    var a = (spec[j - 1].db - srcSpec[j - 1].db) - ref;
    var b = (spec[j].db - srcSpec[j].db) - ref;
    if (b <= -3 && a > -3) {
      var t = (a + 3) / (a - b);
      return cal.BANDS[j - 1] * Math.pow(cal.BANDS[j] / cal.BANDS[j - 1], t);
    }
  }
  return null;
}

var points = [];
found.clips.forEach(function (c, i) {
  var spec = cal.spectrum(w.samples.subarray(c.from, c.to), w.rate, cal.BANDS);

  var rough = cornerOf(spec, cal.BANDS[3]);      // level on the bottom few probes only
  var corner = rough ? cornerOf(spec, Math.max(rough / 3, cal.BANDS[3])) : null;

  console.log('    ' + String(notes[i]).padStart(3) + '   ' +
              c.seconds[0].toFixed(2).padStart(6) + 's       ' +
              (corner ? corner.toFixed(0).padStart(6) + ' Hz' : '  not found'));

  if (corner) points.push({ octaves: (notes[i] - 60) / 12, hz: corner });
});

if (points.length < 2) {
  console.log('');
  console.log('need at least two measurable notes.');
  process.exit(1);
}

// --- slope of log2(cutoff) against octaves of keyboard: that is the tracking fraction
var sx = 0, sy = 0, sxx = 0, sxy = 0, n = points.length;
points.forEach(function (p) {
  var y = Math.log2(p.hz);
  sx += p.octaves; sy += y; sxx += p.octaves * p.octaves; sxy += p.octaves * y;
});

var slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);

var worst = 0;
var intercept = (sy - slope * sx) / n;
points.forEach(function (p) {
  worst = Math.max(worst, Math.abs(Math.log2(p.hz) - (intercept + slope * p.octaves)));
});

console.log('');
console.log('the cutoff moves ' + slope.toFixed(3) + ' octaves per octave of keyboard');
console.log('  worst departure from a straight line: ' + worst.toFixed(2) + ' octaves');
console.log('');

if (slope < 0.1) {
  console.log('  -> keyToFilter 50 is no tracking at all. Set KEY_FULL high enough that 50');
  console.log('     is negligible, or drop key tracking from the model.');
} else {
  var keyFull = 50 / slope;
  console.log('  -> keyToFilter 50 gives ' + (slope * 100).toFixed(0) + '% tracking, so the');
  console.log('     value meaning 1:1 is ' + keyFull.toFixed(0) + '.');
  console.log('');
  console.log('paste into audio.js:');
  console.log('');
  console.log('    KEY_FULL: ' + Math.round(keyFull) + ',         // measured');

  if (Math.abs(keyFull - 50) < 6) {
    console.log('');
    console.log('  (50 - the panel value is half a percent of tracking each)');
  } else if (Math.abs(keyFull - 99) < 8) {
    console.log('');
    console.log('  (99 - the panel value is a straight 0..100% depth)');
  }
}

if (worst > 0.3) {
  console.log('');
  console.log('NOTE: the points do not lie on a line, so something else moved between ' +
              'notes. Check VCF amount, velocity->filter and the LFO are all zero.');
}
