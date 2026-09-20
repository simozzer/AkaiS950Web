/*
 * Render the calibration run through the emulation, as a WAV.
 *
 *   node emulate.js [out.wav] [disk image]
 *
 * The point is to put the model through the same measurement as the hardware. Feed the
 * result to benchcal.js and it should report the constants the model was built from; where
 * it does not, the model and its own constants disagree, which is a bug rather than a
 * calibration gap.
 *
 * It renders exactly what the app plays: the keygroup under each note decides the sample,
 * the filter cutoff and its envelope, and the amplitude envelope - the same functions the
 * browser calls, so this cannot drift away from what you hear.
 */
var fs = require('fs');
var Akai = require('./akai.js');
var Audio = require('./audio.js');
var plan = require('./benchplan.js');

var out = process.argv[2] || 'emulated.wav';
var image = process.argv[3] || 'DSKA0000-bench.hfe';

var RATE = 44100;
var disk = Akai.load('x', new Uint8Array(fs.readFileSync(image)));

var prog = null;
disk.programsInOrder().forEach(function (p) { if (p.name.trim() === 'CALIB') prog = p; });
if (!prog) { console.log('no CALIB program in ' + image); process.exit(1); }

var kgs = disk.keygroups(prog);

function keygroupFor(note) {
  for (var i = 0; i < kgs.length; i++) {
    var kg = kgs[i];
    if (note >= Math.min(kg.lowKey, kg.highKey) && note <= Math.max(kg.lowKey, kg.highKey))
      return { kg: kg, index: i };
  }
  return null;
}

function sampleNamed(name) {
  var found = null;
  disk.entries.forEach(function (e) {
    if (e.type === 'S' && e.name.trim().toUpperCase() === (name || '').trim().toUpperCase()) found = e;
  });
  return found;
}

/**
 * One note, filtered and shaped exactly as the app would play it.
 *
 * The filter runs at the rate the audio leaves at - the sample rate times the playback
 * speed - because on the machine it sits after the varispeed and its cutoff is a fixed
 * number of hertz whatever pitch is playing.
 */
function renderNote(note, velocity, seconds) {
  var hit = keygroupFor(note);
  if (!hit) return new Float32Array(Math.round(seconds * RATE));

  var kg = hit.kg;
  var zone = kg.zone1;
  var smp = sampleNamed(zone.name);
  if (!smp && kg.zone2.inUse) { zone = kg.zone2; smp = sampleNamed(zone.name); }
  if (!smp) return new Float32Array(Math.round(seconds * RATE));

  var words = disk.sampleWords12(smp);
  var shift = kg.constantPitch
    ? zone.transpose + zone.fine / 256
    : (note - (smp.nominalPitch + smp.finePitch / 16)) + zone.transpose + zone.fine / 256;
  var speed = Math.pow(2, shift / 12);

  var filtered = Audio.applyVcf(words, smp.sampleRate * speed, kg, zone, note, velocity);
  var env = Audio.vcaEnvelope(kg, zone, velocity);

  // resample to the output rate, and apply the amplitude envelope as it goes
  var n = Math.round(seconds * RATE);
  var buf = new Float32Array(n);
  var step = smp.sampleRate * speed / RATE;

  var held = env.peak * env.sustain;

  for (var i = 0; i < n; i++) {
    var src = i * step;
    var j = Math.floor(src);
    if (j + 1 >= filtered.length) break;

    var frac = src - j;
    var v = filtered[j] * (1 - frac) + filtered[j + 1] * frac;

    var t = i / RATE, gain;
    if (t < env.attack) gain = env.peak * (env.attack > 0 ? t / env.attack : 1);
    else if (t < env.attack + env.decay) {
      // straight in decibels, matching the exponential ramp the browser schedules
      var u = (t - env.attack) / env.decay;
      gain = env.peak * Math.pow(held / env.peak, u);
    }
    else gain = held;

    buf[i] = v * gain;
  }
  return buf;
}

// --- lay the run out on the same timeline the MIDI file uses
var t = plan.TIMING;
var pieces = [];

function silence(seconds) {
  pieces.push(new Float32Array(Math.round(seconds * RATE)));
}

silence(t.lead);

plan.clips().forEach(function (c, i) {
  if (i > 0 && c.first) silence(t.sectionGap - t.gap);
  pieces.push(renderNote(c.note, c.velocity, t.hold));
  silence(t.gap);
});

var total = pieces.reduce(function (a, x) { return a + x.length; }, 0);
var all = new Float32Array(total);
var at = 0;
pieces.forEach(function (x) { all.set(x, at); at += x.length; });

// normalise to a comfortable level: the measurements are all ratios, but a clipped or
// vanishing file would measure badly for reasons that have nothing to do with the model
var peak = 0;
for (var i = 0; i < all.length; i++) peak = Math.max(peak, Math.abs(all[i]));
var gain = peak > 0 ? 0.7 / peak : 1;

var b = Buffer.alloc(44 + total * 2);
b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + total * 2, 4); b.write('WAVE', 8, 'ascii');
b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28);
b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
b.write('data', 36, 'ascii'); b.writeUInt32LE(total * 2, 40);

for (var i = 0; i < total; i++)
  b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(all[i] * gain * 32767))), 44 + i * 2);

fs.writeFileSync(out, b);

console.log('');
console.log('wrote ' + out + '  (' + (total / RATE).toFixed(1) + 's, ' +
            plan.clips().length + ' notes, peak scaled to -3 dBFS)');
console.log('');
console.log('now run:  node benchcal.js ' + out);
console.log('and compare what it reports with the constants in audio.js - they should agree.');
