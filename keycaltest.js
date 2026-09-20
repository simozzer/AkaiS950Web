/*
 * Does keycal.js recover a tracking fraction it is not told?
 *
 * Synthesise what the S950 would send back: the real NOISE sample from the disk image,
 * filtered at the cutoff a given tracking fraction implies for each note, with gaps
 * between and a different level on each note - because the take will not be level-matched
 * and the answer must not depend on that.
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var Audio = require('./audio.js');
var Akai = require('./akai.js');
var W = __dirname + '/';

var disk = Akai.load('x', new Uint8Array(fs.readFileSync(W + 'DSKA0000-bench.hfe')));
var smp = null;
disk.entries.forEach(function (e) { if (e.type === 'S' && e.name.trim() === 'NOISE') smp = e; });
var words = disk.sampleWords12(smp);

var RATE = smp.sampleRate;
var BASE = 1340;                     // what filter 50 comes to at this rate
var NOTES = [24, 48, 72];

function wav(samples, rate) {
  var n = samples.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  for (var i = 0; i < n; i++)
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 26000))), 44 + i * 2);
  return b;
}

var dir = path.join(os.tmpdir(), 'keycal_selftest');
try { fs.mkdirSync(dir); } catch (e) { /* already there */ }

var problems = 0;

[0.5, 1.0, 0.0].forEach(function (track) {
  var pieces = [];

  NOTES.forEach(function (note, idx) {
    var hz = BASE * Math.pow(2, ((note - 60) / 12) * track);
    var clip = Audio.filterWords(words, RATE, function () { return hz; });

    // a different level on each note, since a real take will not be matched
    var gain = [0.5, 1.0, 0.7][idx];
    var scaled = new Float32Array(clip.length);
    for (var i = 0; i < clip.length; i++) scaled[i] = clip[i] * gain;

    var gap = new Float32Array(Math.round(RATE * 0.5));
    for (var i = 0; i < gap.length; i++) gap[i] = (Math.random() * 2 - 1) * 0.0002;

    pieces.push(gap, scaled);
  });

  var total = pieces.reduce(function (a, x) { return a + x.length; }, 0);
  var joined = new Float32Array(total);
  var at = 0;
  pieces.forEach(function (x) { joined.set(x, at); at += x.length; });

  var file = path.join(dir, 'track' + Math.round(track * 100) + '.wav');
  fs.writeFileSync(file, wav(joined, RATE));

  var out = require('child_process').execSync(
    'node "' + W + 'keycal.js" "' + file + '" ' + NOTES.join(',') + ' "' + W + 'DSKA0000-bench.hfe"',
    { encoding: 'utf8' });

  var m = out.match(/moves (-?[\d.]+) octaves per octave/);
  var got = m ? parseFloat(m[1]) : NaN;
  var ok = !isNaN(got) && Math.abs(got - track) < 0.08;
  if (!ok) problems++;

  console.log((ok ? '  ok   ' : '  FAIL ') + 'tracking ' + track.toFixed(2) +
              ' recovered as ' + (isNaN(got) ? 'nothing' : got.toFixed(3)));

  if (track === 0.5) {
    var k = out.match(/KEY_FULL: (\d+)/);
    console.log('         and it suggests KEY_FULL: ' + (k ? k[1] : '?') + '  (about 100 is right: 50 giving half tracking means 1:1 sits near 99)');
  }
});

console.log('');
console.log(problems ? problems + ' FAILED' : 'keycal recovers tracking it was not told');
process.exit(problems ? 1 : 0);
