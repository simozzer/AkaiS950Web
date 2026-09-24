/*
 * The VCF, measured rather than asserted.
 *
 * The S950's filter is a 6th-order Butterworth low-pass. That part of the emulation is
 * exactly specifiable, so it is held to the textbook figures: a maximally flat passband
 * with no ripple, -3.01 dB at the cutoff, and 36 dB per octave beyond it.
 *
 * The frequency mapping is a different matter - every constant in AkaiAudio.CAL is an
 * assumption until vcfcal.js has been run against recordings of the hardware. What is
 * checked here is only that the mapping is monotonic and lands where it claims to.
 *
 *   node vcftest.js
 */
var Audio = require('../audio.js');

var problems = [];
function check(name, ok, detail) {
  if (!ok) problems.push(name + (detail ? '  -  ' + detail : ''));
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '   (' + detail + ')' : ''));
}

/** Magnitude response of the cascade at one frequency, in dB. */
function dbAt(secs, f, fs) {
  var w = 2 * Math.PI * f / fs, re = 1, im = 0;

  secs.forEach(function (s) {
    var nr = s.b[0] + s.b[1] * Math.cos(-w) + s.b[2] * Math.cos(-2 * w);
    var ni = s.b[1] * Math.sin(-w) + s.b[2] * Math.sin(-2 * w);
    var dr = s.a[0] + s.a[1] * Math.cos(-w) + s.a[2] * Math.cos(-2 * w);
    var di = s.a[1] * Math.sin(-w) + s.a[2] * Math.sin(-2 * w);
    var d = dr * dr + di * di;
    var hr = (nr * dr + ni * di) / d, hi = (ni * dr - nr * di) / d;
    var r2 = re * hr - im * hi, i2 = re * hi + im * hr;
    re = r2; im = i2;
  });
  return 20 * Math.log10(Math.sqrt(re * re + im * im) || 1e-300);
}

var fs = 44100, fc = 1000;
var secs = Audio.butterworth(fc, fs);

console.log('');
console.log('the filter itself, cutoff ' + fc + ' Hz at ' + fs + ' Hz:');

check('three biquad sections', secs.length === 3, secs.length + ' sections');

var atFc = dbAt(secs, fc, fs);
check('-3.01 dB at the cutoff', Math.abs(atFc + 3.0103) < 0.05, atFc.toFixed(3) + ' dB');

// maximally flat: monotonically falling, never above unity anywhere in the passband
var worst = -999, rising = 0, prev = 0;
for (var f = 10; f < fc; f += 5) {
  var v = dbAt(secs, f, fs);
  if (v > worst) worst = v;
  if (v > prev + 1e-6) rising++;
  prev = v;
}
check('no passband ripple or gain', worst <= 0.001, 'peak ' + worst.toFixed(4) + ' dB');
check('passband falls monotonically', rising === 0, rising + ' rises');

// 36 dB/octave, measured where the digital filter is still far from Nyquist
var slope = dbAt(secs, 2 * fc, fs) - dbAt(secs, fc, fs);
check('about 36 dB in the first octave past cutoff', slope < -30 && slope > -40,
      slope.toFixed(1) + ' dB');

var slope2 = dbAt(secs, 4 * fc, fs) - dbAt(secs, 2 * fc, fs);
check('about 36 dB in the next octave', slope2 < -33 && slope2 > -42, slope2.toFixed(1) + ' dB');

// the cutoff must track what was asked for, across rates the sampler actually uses
console.log('');
console.log('cutoff accuracy across the S950 sample rates:');
[[12500, 500], [12500, 2000], [20000, 1000], [40000, 5000], [44100, 10000]].forEach(function (p) {
  var s = Audio.butterworth(p[1], p[0]);
  var at = dbAt(s, p[1], p[0]);
  check(p[1] + ' Hz at ' + p[0] + ' Hz', Math.abs(at + 3.0103) < 0.35, at.toFixed(2) + ' dB');
});

// a cutoff above Nyquist must not blow up - most zones sit at 99, wide open
console.log('');
console.log('degenerate cases:');
var open = Audio.butterworth(20000, 12500);
check('cutoff above Nyquist stays finite',
      open.every(function (s) { return s.b.concat(s.a).every(function (v) { return isFinite(v); }); }));

var zero = Audio.butterworth(0, 44100);
check('cutoff of zero stays finite',
      zero.every(function (s) { return s.b.concat(s.a).every(function (v) { return isFinite(v); }); }));

// the stored 0..99 mapping: monotonic, and hitting its stated ends
console.log('');
console.log('the stored 0..99 cutoff mapping (measured on the hardware):');
// It never falls - but it does not always rise either. The hardware runs into a stop at
// each end, so the first and last stretches of the control are genuinely flat.
var falls = 0, rises = 0, last = -1;
for (var v = 0; v <= 99; v++) {
  var hz = Audio.cutoffHz(v, 44100);
  if (last >= 0 && hz < last - 1e-9) falls++;
  if (last >= 0 && hz > last + 1e-9) rises++;
  last = hz;
}
check('never falls as the stored value rises', falls === 0, falls + ' fall');
check('rises through the middle of the range', rises > 40, rises + ' of 99 steps move');

// Wide open is the reconstruction limit, measured at 0.370 of the rate on the hardware
// (Akai quote 0.4, which is the same figure rounded generously).
check('99 gives MAX_RATIO x the sample rate',
      Math.abs(Audio.cutoffHz(99, 48000) - 0.37 * 48000) < 1,
      Audio.cutoffHz(99, 48000).toFixed(0) + ' Hz at 48k');

// The six points the ladder actually measured, at 44100 Hz
var LADDER = [[0, 311], [20, 310], [40, 1139], [60, 4813], [80, 16312], [99, 16309]];
var worstLadder = 0;
LADDER.forEach(function (pt) {
  worstLadder = Math.max(worstLadder, Math.abs(Math.log2(Audio.cutoffHz(pt[0], 44100) / pt[1])));
});
check('reproduces the measured ladder', worstLadder < 0.02,
      'worst ' + (worstLadder * 100).toFixed(1) + '% of an octave');

// the stops: it will not close below the floor nor open past the ceiling
check('will not close below the floor',
      Math.abs(Audio.cutoffHz(0, 44100) - Audio.CAL.FLOOR_HZ) < 1,
      Audio.cutoffHz(0, 44100).toFixed(0) + ' Hz');

check('the top of the travel stays under Nyquist',
      [7500, 12500, 20000, 40000, 48000].every(function (r) {
        return Audio.cutoffHz(99, r) < r / 2;
      }));

// key tracking is the firmest measurement of the lot: 50 is one for one
var trackKg2 = { vca: [0,0,99,0], vcf: [0,0,99,0], vcfWritten: false, vcfAmount: 0,
                 velToFilter: 0, keyToFilter: 50, velToLoudness: 0 };
var t1 = Audio.vcfEnvelope(trackKg2, { filter: 50 }, 60, 100, 44100)(0);
var t2 = Audio.vcfEnvelope(trackKg2, { filter: 50 }, 72, 100, 44100)(0);
check('keyToFilter 50 tracks one for one', Math.abs(Math.log2(t2 / t1) - 1) < 0.05,
      t1.toFixed(0) + ' -> ' + t2.toFixed(0) + ' Hz for an octave up');

check('out of range values are clamped',
      Audio.cutoffHz(-5, 40000) === Audio.cutoffHz(0, 40000) &&
      Audio.cutoffHz(200, 40000) === Audio.cutoffHz(99, 40000));

// filtering real audio: quiet the treble, keep the bass, stay finite
console.log('');
console.log('filtering a signal:');
var rate = 20000, n = rate;
var low = new Int16Array(n), high = new Int16Array(n);
for (var i = 0; i < n; i++) {
  low[i] = Math.round(1500 * Math.sin(2 * Math.PI * 200 * i / rate));
  high[i] = Math.round(1500 * Math.sin(2 * Math.PI * 7000 * i / rate));
}

function rms(a, from) {
  var s = 0, c = 0;
  for (var i = from || 0; i < a.length; i++) { s += a[i] * a[i]; c++; }
  return Math.sqrt(s / c);
}

var flat = function () { return 1000; };
var lowOut = Audio.filterWords(low, rate, flat);
var highOut = Audio.filterWords(high, rate, flat);

check('all output is finite', lowOut.every(isFinite) && highOut.every(isFinite));

var lowKept = rms(lowOut, rate / 10) / (rms(low, rate / 10) / 2048);
check('200 Hz passes a 1 kHz cutoff', lowKept > 0.9, (lowKept * 100).toFixed(1) + '% kept');

var highKept = rms(highOut, rate / 10) / (rms(high, rate / 10) / 2048);
check('7 kHz is crushed by a 1 kHz cutoff', highKept < 0.01,
      (20 * Math.log10(highKept || 1e-12)).toFixed(0) + ' dB');

// a moving cutoff must not click or blow up
var sweep = Audio.filterWords(low, rate, function (t) { return 200 + 6000 * t; });
check('a swept cutoff stays finite', sweep.every(isFinite));
var jump = 0;
for (var i = 1; i < sweep.length; i++) jump = Math.max(jump, Math.abs(sweep[i] - sweep[i - 1]));
check('a swept cutoff does not click', jump < 0.5, 'largest step ' + jump.toFixed(3));

// --- the cutoff can never exceed the travel
//
// The VCF is also the reconstruction filter, so 0.4 x the sample rate is a hardware
// limit, not a preference. Velocity and key tracking both push the cutoff up, and a
// wide-open keygroup with any depth at all would sail past it - previewing brighter
// than the machine can physically be.
console.log("");
console.log("the cutoff stays inside the filter travel:");

var over = 0, under = 0, tried = 0;
[7500, 12500, 20000, 40000, 44100].forEach(function (rate) {
  [0, 50, 99].forEach(function (filt) {
    [0, 50, 99].forEach(function (keyTrack) {
      [0, 10, 99].forEach(function (velTrack) {
        [-50, 0, 50].forEach(function (amount) {
          var kg = { vca: [0,0,99,0], vcf: [0,0,99,0], vcfAmount: amount,
                     velToFilter: velTrack, keyToFilter: keyTrack, velToLoudness: 0 };
          var at = Audio.vcfEnvelope(kg, { filter: filt }, 127, 127, rate);
          [0, 0.5, 2, 30].forEach(function (t) {
            var hz = at(t);
            tried++;
            if (hz > 0.4 * rate + 0.5) over++;
            if (!(hz > 0) || !isFinite(hz)) under++;
          });
        });
      });
    });
  });
});

check("never opens past 0.4 x the sample rate", over === 0, over + " of " + tried + " over");
check("never reaches zero or infinity", under === 0, under + " of " + tried + " bad");

// no tracking means the key makes no difference
var flatKg = { vca: [0,0,99,0], vcf: [0,0,99,0], vcfAmount: 0,
               velToFilter: 0, keyToFilter: 0, velToLoudness: 0 };
var lo = Audio.vcfEnvelope(flatKg, { filter: 99 }, 12, 100, 44100)(0);
var hi = Audio.vcfEnvelope(flatKg, { filter: 99 }, 120, 100, 44100)(0);
check("no key tracking means the key does not move the cutoff", Math.abs(lo - hi) < 1,
      lo.toFixed(0) + " vs " + hi.toFixed(0) + " Hz");

// full tracking follows the keyboard one for one
// 50 is one for one, so 99 is very nearly two for one. Filter 50 keeps both notes clear
// of the stops, which a lower setting would not.
var trackKg = { vca: [0,0,99,0], vcf: [0,0,99,0], vcfWritten: false, vcfAmount: 0,
                velToFilter: 0, keyToFilter: 99, velToLoudness: 0 };
var a1 = Audio.vcfEnvelope(trackKg, { filter: 50 }, 48, 100, 44100)(0);
var a2 = Audio.vcfEnvelope(trackKg, { filter: 50 }, 60, 100, 44100)(0);
check("keyToFilter 99 is about two octaves per octave",
      Math.abs(Math.log2(a2/a1) - 99/50) < 0.05,
      a1.toFixed(0) + " -> " + a2.toFixed(0) + " Hz for one octave up");

// --- a filter envelope that was never written
//
// The S900 had no filter envelope, so its programs leave bytes 34..37 as ASCII spaces -
// 1684 of the 1936 keygroups in the library. Space is 32, a perfectly plausible setting,
// so reading it as one gives an envelope nobody asked for. It is latent in the library,
// where no blank keygroup sets a VCF amount, but it would bite the moment one did.
console.log("");
console.log("a filter envelope that was never written:");

function blankKg(amount) {
  return { vca: [0,0,99,0], vcf: [32,32,32,32], vcfWritten: false, vcfAmount: amount,
           velToFilter: 0, keyToFilter: 0, velToLoudness: 0 };
}
function realKg(amount) {
  return { vca: [0,0,99,0], vcf: [0,40,20,0], vcfWritten: true, vcfAmount: amount,
           velToFilter: 0, keyToFilter: 0, velToLoudness: 0 };
}

var blankAt = Audio.vcfEnvelope(blankKg(50), { filter: 60 }, 60, 100, 44100);
check("a blank envelope leaves the cutoff alone",
      Math.abs(blankAt(0) - blankAt(5)) < 1 && Math.abs(blankAt(0) - blankAt(0.05)) < 1,
      blankAt(0).toFixed(0) + " Hz throughout");

var realAt = Audio.vcfEnvelope(realKg(50), { filter: 60 }, 60, 100, 44100);
check("a written envelope does move it", Math.abs(realAt(5) - realAt(0)) > 100,
      realAt(0).toFixed(0) + " -> " + realAt(5).toFixed(0) + " Hz");

check("a blank envelope matches amount zero",
      Math.abs(blankAt(5) - Audio.vcfEnvelope(blankKg(0), { filter: 60 }, 60, 100, 44100)(5)) < 1);

// --- the amplitude envelope
//
// The keygroup's four VCA values become times and a level. Nothing here is measured -
// the time scale is the same assumed 1 ms .. 10 s as the filter envelope - so what is
// checked is that the shape is right and the degenerate settings behave: a zero attack
// is instant rather than silent, a zero sustain still sounds during the attack, and a
// full sustain holds at full level.
console.log('');
console.log('the amplitude envelope:');

function kgWith(vca, velToLoudness) {
  return { vca: vca, vcf: [0, 0, 99, 0], vcfAmount: 0,
           velToFilter: 0, keyToFilter: 0, velToLoudness: velToLoudness || 0 };
}

// The measured level laws: sustain and velocity count decibels, not amplitude. Both were
// modelled as fractions of the amplitude and both were badly wrong - sustain 50 by 14 dB.
function dbOf(g) { return 20 * Math.log10(g); }

var sus50 = Audio.vcaEnvelope(kgWith([0, 0, 50, 0]), null, 100);
check('sustain 50 is 19.7 dB down, not 5.9', Math.abs(dbOf(sus50.sustain) + 19.7) < 0.3,
      dbOf(sus50.sustain).toFixed(1) + ' dB');

var loud = Audio.vcaEnvelope(kgWith([0, 0, 99, 0]), { loudness: 20 }, 100);
check('zone loudness +20 is 5.8 dB up', Math.abs(dbOf(loud.peak) - 5.8) < 0.3,
      dbOf(loud.peak).toFixed(1) + ' dB');

var hard = Audio.vcaEnvelope(kgWith([0, 0, 99, 0], 99), null, 120).peak;
var soft = Audio.vcaEnvelope(kgWith([0, 0, 99, 0], 99), null, 20).peak;
// The hardware cannot show this span directly - at 0.63 dB a step, velocity 20 lands
// below the noise floor and the note is missing from the take entirely. It is fixed by
// the two velocities that did sound, 70 and 120, which measured 31.6 dB apart.
check('velocity 20 is 63 dB below 120 at full depth',
      Math.abs(dbOf(soft / hard) + 63.0) < 1.5, dbOf(soft / hard).toFixed(1) + ' dB');

var mid = Audio.vcaEnvelope(kgWith([0, 0, 99, 0], 99), null, 70).peak;
check('velocity 70 is 31.6 dB below 120, as measured',
      Math.abs(dbOf(mid / hard) + 31.6) < 1.0, dbOf(mid / hard).toFixed(1) + ' dB');

// Timed from the note-on. The earlier 1.75 s came from the clip splitter's idea of where
// a note starts, which is about 0.3 s late - see benchcal.js.
check('a decay of 80 takes about 2.87 s',
      Math.abs(Audio.vcaEnvelope(kgWith([0, 80, 0, 0]), null, 100).decay - 2.87) < 0.15,
      Audio.vcaEnvelope(kgWith([0, 80, 0, 0]), null, 100).decay.toFixed(2) + 's');

check('an attack of 70 takes about 1.5 s',
      Math.abs(Audio.vcaEnvelope(kgWith([70, 0, 99, 0]), null, 100).attack - 1.50) < 0.2,
      Audio.vcaEnvelope(kgWith([70, 0, 99, 0]), null, 100).attack.toFixed(2) + 's');

var flatGate = Audio.vcaEnvelope(kgWith([0, 0, 99, 0]), null, 100);
// A stored 0 is the bottom of the envelope scale rather than a true zero: 1.68 ms, times
// the attack's own 1.33. Inaudible, and the callers treat anything under 2 ms as a step.
check('instant attack is instant', flatGate.attack < 0.003,
      (flatGate.attack * 1000).toFixed(1) + ' ms');
check('full sustain holds at full level', Math.abs(flatGate.sustain - 1) < 0.02,
      flatGate.sustain.toFixed(3));
check('a flat gate has nothing to release', flatGate.release < 0.002);

var slow = Audio.vcaEnvelope(kgWith([99, 99, 50, 99]), null, 100);
// attack runs about 1.6 times slower than decay for the same stored number
check('a full attack is the top of the scale times ATTACK_SCALE',
      Math.abs(slow.attack - Audio.CAL.ENV_MAX_MS / 1000 * Audio.CAL.ATTACK_SCALE) < 0.01,
      slow.attack.toFixed(2) + ' s');
check('half sustain is 20 dB down, not half', Math.abs(dbOf(slow.sustain) + 19.7) < 0.5,
      dbOf(slow.sustain).toFixed(1) + ' dB');
check('release follows the decay scale, not the attack one',
      Math.abs(slow.release - slow.decay) < 0.01,
      slow.release.toFixed(2) + 's release, ' + slow.decay.toFixed(2) + 's decay');

// times must rise with the stored value, and never be negative
var rising = true, lastT = -1;
for (var v = 0; v <= 99; v++) {
  var t = Audio.vcaEnvelope(kgWith([v, 0, 99, 0]), null, 100).attack;
  if (t <= lastT || t < 0) rising = false;
  lastT = t;
}
check('attack time rises with the stored value', rising);

// velocity: full velocity is full level whatever the depth, and a soft note is quieter
// only when the keygroup asks for it
check('full velocity is full level',
      Math.abs(Audio.vcaEnvelope(kgWith([0, 0, 99, 0], 99), null, 127).peak - 1) < 0.01);
check('no velocity depth means level is fixed',
      Math.abs(Audio.vcaEnvelope(kgWith([0, 0, 99, 0], 0), null, 1).peak - 1) < 0.01);

var soft2 = Audio.vcaEnvelope(kgWith([0, 0, 99, 0], 99), null, 20).peak;
var hard2 = Audio.vcaEnvelope(kgWith([0, 0, 99, 0], 99), null, 120).peak;
check('a soft note is quieter than a hard one', soft2 < hard2 && soft2 >= 0,
      soft2.toExponential(1) + ' vs ' + hard2.toFixed(3));

// every value stays usable as a gain - no negatives, no NaN, nothing over unity
var sane = true;
for (var a = 0; a <= 99; a += 33)
  for (var d = 0; d <= 99; d += 33)
    for (var su = 0; su <= 99; su += 33)
      for (var r = 0; r <= 99; r += 33) {
        var e2 = Audio.vcaEnvelope(kgWith([a, d, su, r]), null, 100);
        if (!(e2.peak >= 0 && e2.peak <= 1 && e2.sustain >= 0 && e2.sustain <= 1 &&
              isFinite(e2.attack) && isFinite(e2.decay) && isFinite(e2.release))) sane = false;
      }
check('every combination gives a usable gain', sane);

// --- the WAV reader, at every bit depth
//
// This is the first thing every calibration touches and the easiest place to be wrong
// without noticing: the 24-bit path was reading ((b0 | b1<<8 | b2<<16) << 8) >> 8, which
// parses as a shift by 24 and back by 8 - dropping the low byte and mangling the sign.
// A real 24-bit recording came back as near-silence, and the only reason it was caught
// is that the silence was too perfect. Round-trip every depth against a known signal.
var fileio2 = require('fs');
var os2 = require('os'), path2 = require('path');
var cal2 = require('../tools/vcfcal.js');

var wdir = path2.join(os2.tmpdir(), 'vcfwav_selftest');
try { fileio2.mkdirSync(wdir); } catch (e) { /* already there */ }

function writeWav(file, samples, rate, bits) {
  var bytes = bits / 8, n = samples.length;
  var b = Buffer.alloc(44 + n * bytes);

  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * bytes, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(bits === 32 ? 3 : 1, 20);            // 32-bit written as float
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * bytes, 28); b.writeUInt16LE(bytes, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * bytes, 40);

  for (var i = 0; i < n; i++) {
    var at = 44 + i * bytes, v = samples[i];
    if (bits === 8) b[at] = Math.round(v * 127) + 128;
    else if (bits === 16) b.writeInt16LE(Math.round(v * 32767), at);
    else if (bits === 24) {
      var q = Math.round(v * 8388607);
      if (q < 0) q += 0x1000000;
      b[at] = q & 0xFF; b[at + 1] = (q >> 8) & 0xFF; b[at + 2] = (q >> 16) & 0xFF;
    } else b.writeFloatLE(v, at);
  }
  fileio2.writeFileSync(file, b);
}

console.log('');
console.log('the WAV reader:');

var probe = [];
for (var i = 0; i < 2000; i++) probe.push(0.8 * Math.sin(2 * Math.PI * 440 * i / 44100));
probe[0] = 0.9; probe[1] = -0.9; probe[2] = 0;          // both signs and zero

[8, 16, 24, 32].forEach(function (bits) {
  var file = path2.join(wdir, bits + 'bit.wav');
  writeWav(file, probe, 44100, bits);

  var got = cal2.readWav(file);
  // 8-bit WAV is unsigned with 128 as zero, so a step is 1/128 and full scale is written
  // as +/-127 but read as a fraction of 128 - a 0.8% scale difference on top of the step.
  // Nobody calibrates at 8 bits; it only has to be roughly right.
  var tol = bits === 8 ? 0.02 : 0.0005;

  var worstErr = 0;
  for (var i = 0; i < probe.length; i++)
    worstErr = Math.max(worstErr, Math.abs(got.samples[i] - probe[i]));

  check(bits + '-bit reads back correctly', worstErr < tol && got.rate === 44100,
        'worst error ' + worstErr.toExponential(1) + ', rate ' + got.rate);

  // a level measured from the file must match the level that went in
  var sumIn = 0, sumOut = 0;
  for (var i = 0; i < probe.length; i++) { sumIn += probe[i] * probe[i]; sumOut += got.samples[i] * got.samples[i]; }
  var dbErr = Math.abs(10 * Math.log10(sumOut / sumIn));
  check(bits + '-bit preserves the level', dbErr < 0.1, dbErr.toFixed(3) + ' dB out');

  // negative samples must stay negative - the 24-bit bug broke exactly this
  check(bits + '-bit keeps the sign', got.samples[1] < -0.5,
        'wrote -0.9, read ' + got.samples[1].toFixed(4));
});

// --- the calibrator, measured against an answer it is not told
//
// vcfcal.js is the instrument that will replace the assumed constants with real ones,
// so it needs checking itself. Noise is filtered at cutoffs from a mapping the tool
// never sees, written out as WAVs, and the tool has to recover that mapping. Its first
// version did not - a single stretch of noise scatters several dB per band and the
// corners landed anywhere - which is exactly the kind of error a confident-looking
// number hides.
// 'fs' is already the sample rate in this file, so the module gets another name
var fileio = require('fs');
var os = require('os'), pathmod = require('path');
var cal = require('../tools/vcfcal.js');

var TRUE_MIN = 180, TRUE_MAX = 16500, CRATE = 44100;
var caldir = pathmod.join(os.tmpdir(), 'vcfcal_selftest');
try { fileio.mkdirSync(caldir); } catch (e) { /* already there */ }

function wav(samples, rate) {
  var n = samples.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  for (var i = 0; i < n; i++)
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 20000))), 44 + i * 2);
  return b;
}

var noiseN = Math.round(CRATE * 1.5), noise = new Int16Array(noiseN), seed = 12345;
for (var i = 0; i < noiseN; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  noise[i] = ((seed / 0x7fffffff) * 2 - 1) * 1500;
}

[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 99].forEach(function (v) {
  var hz = TRUE_MIN * Math.pow(TRUE_MAX / TRUE_MIN, v / 99);
  var out = Audio.filterWords(noise, CRATE, function () { return hz; });
  fileio.writeFileSync(pathmod.join(caldir, (v < 10 ? '0' : '') + v + '.wav'), wav(out, CRATE));
});

console.log('');
console.log('the calibrator, against a mapping it is not given:');

var got = cal.analyse(caldir);

var minErr = Math.abs(Math.log2(got.minHz / TRUE_MIN));
var maxErr = Math.abs(Math.log2(got.maxHz / TRUE_MAX));

check('recovers the bottom of the range', minErr < 0.1,
      got.minHz.toFixed(0) + ' Hz vs ' + TRUE_MIN + ', ' + (minErr * 100).toFixed(1) + '% of an octave');
check('recovers the top of the range', maxErr < 0.1,
      got.maxHz.toFixed(0) + ' Hz vs ' + TRUE_MAX + ', ' + (maxErr * 100).toFixed(1) + '% of an octave');
check('calls the mapping exponential', got.exponential,
      'worst deviation ' + got.worstOctaves.toFixed(3) + ' octaves');

var used = got.readings.filter(function (r) { return r.used; });
check('measures most of the settings', used.length >= 6, used.length + ' usable readings');

var worstOne = 0;
used.forEach(function (r) {
  var want = TRUE_MIN * Math.pow(TRUE_MAX / TRUE_MIN, r.setting / 99);
  worstOne = Math.max(worstOne, Math.abs(Math.log2(r.corner / want)));
});
check('every reading is close to the truth', worstOne < 0.1,
      'worst ' + (worstOne * 100).toFixed(1) + '% of an octave');

// --- the same thing from one recording, split on silence
//
// Eleven clips in a single file is the easier thing to record, and the harder thing to
// read: the clips are not equally loud. At a low cutoff most of the noise is gone, so
// the quietest clip sits far below the open one. A silence threshold set as a fraction
// of the loudest clip drops it, every later clip is then matched to the wrong setting,
// and the fit comes out confidently wrong. The gaps here carry a little hiss, as a real
// recording would, so the split cannot lean on digital silence either.
var GAP = 0.4;

var oneFile = pathmod.join(caldir, 'all-in-one.wav');
var pieces = [];

[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 99].forEach(function (v) {
  var hz = TRUE_MIN * Math.pow(TRUE_MAX / TRUE_MIN, v / 99);
  var clip = Audio.filterWords(noise, CRATE, function () { return hz; });

  var gap = new Float32Array(Math.round(CRATE * GAP));
  for (var i = 0; i < gap.length; i++) gap[i] = (Math.random() * 2 - 1) * 0.00015;

  pieces.push(gap, clip);
});

var total = pieces.reduce(function (a, x) { return a + x.length; }, 0);
var joined = new Float32Array(total);
var at = 0;
pieces.forEach(function (x) { joined.set(x, at); at += x.length; });

fileio.writeFileSync(oneFile, wav(joined, CRATE));

console.log('');
console.log('one recording holding all eleven clips:');

var loud = [];
[0, 50, 99].forEach(function (v) {
  var hz = TRUE_MIN * Math.pow(TRUE_MAX / TRUE_MIN, v / 99);
  var c = Audio.filterWords(noise, CRATE, function () { return hz; });
  var sum = 0;
  for (var i = 0; i < c.length; i++) sum += c[i] * c[i];
  loud.push(v + ': ' + (10 * Math.log10(sum / c.length)).toFixed(0) + ' dB');
});
console.log('  clip levels vary a lot, as they will in reality - ' + loud.join(', '));

var one;
try { one = cal.analyseFile(oneFile); }
catch (e) { one = null; check('splits into eleven clips', false, e.message); }

if (one) {
  check('splits into eleven clips', one.clips.length === 11, one.clips.length + ' found');

  var mislabelled = one.clips.filter(function (c, i) {
    return c.setting !== [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 99][i];
  });
  check('clips line up with their settings', mislabelled.length === 0);

  // each clip should start near the gap that precedes it
  var spacing = true;
  one.clips.forEach(function (c, i) {
    var expect = GAP * (i + 1) + 1.5 * i;
    if (Math.abs(c.seconds[0] - expect) > 0.3) spacing = false;
  });
  check('clips are found where they were put', spacing);

  var minErr1 = Math.abs(Math.log2(one.minHz / TRUE_MIN));
  var maxErr1 = Math.abs(Math.log2(one.maxHz / TRUE_MAX));
  check('recovers the bottom of the range from one file', minErr1 < 0.1,
        one.minHz.toFixed(0) + ' Hz vs ' + TRUE_MIN);
  check('recovers the top of the range from one file', maxErr1 < 0.1,
        one.maxHz.toFixed(0) + ' Hz vs ' + TRUE_MAX);

  // and it must agree with the same data supplied as separate files
  var agree = Math.abs(Math.log2(one.minHz / got.minHz)) < 0.05 &&
              Math.abs(Math.log2(one.maxHz / got.maxHz)) < 0.05;
  check('one file agrees with eleven files', agree,
        one.minHz.toFixed(0) + '/' + one.maxHz.toFixed(0) + ' vs ' +
        got.minHz.toFixed(0) + '/' + got.maxHz.toFixed(0));
}

// a recording with no silence in it must fail to split, not split wrongly
var noGaps = pathmod.join(caldir, 'no-gaps.wav');
var solid = new Float32Array(CRATE * 3);
for (var i = 0; i < solid.length; i++) solid[i] = (Math.random() * 2 - 1) * 0.3;
fileio.writeFileSync(noGaps, wav(solid, CRATE));

var refused = false;
try { cal.analyseFile(noGaps); } catch (e) { refused = true; }
check('a recording with no gaps is refused', refused);

// ---------------------------------------------------------- the filter's release
//
// The machine closes the filter back towards the keygroup's own cutoff as a note dies.
// This version bakes the filter into the buffer before the note starts, so the release
// has to be rendered when the key comes up and spliced on - which is the part worth
// holding, because a splice that does not line up is a click.

(function () {
  var RATE = 44100;

  // A keygroup nearly shut, with the envelope opening it wide and holding it there, so
  // letting go has somewhere to fall from.
  var kg = {
    vcf: [0, 99, 99, 60],          // attack, decay, sustain, release
    vcfAmount: 50,
    vcfWritten: true,
    keyToFilter: 0,
    velToFilter: 0
  };
  var zone = { filter: 20 };

  // a sawtooth, which has harmonics for the filter to take away
  var words = new Int16Array(RATE * 2);
  for (var i = 0; i < words.length; i++) words[i] = ((i % 120) / 120) * 4000 - 2000;

  var env = Audio.vcfEnvelope(kg, zone, 60, 100, RATE);
  check('the release time comes off the fourth byte', env.releaseSeconds > 0.3,
        env.releaseSeconds.toFixed(2) + 's');

  // Held, the envelope sits open; released, it falls back to the keygroup's own cutoff.
  var closing = env.withRelease(1.0);
  var open = closing(1.0);
  var shut = closing(1.0 + env.releaseSeconds + 0.01);
  var base = Audio.cutoffHz(20, RATE);

  check('the filter is open while the key is held', open > base * 4,
        open.toFixed(0) + ' Hz against a base of ' + base.toFixed(0));
  check('and falls back to the keygroup cutoff after the release',
        Math.abs(shut - base) < base * 0.02, shut.toFixed(0) + ' Hz vs ' + base.toFixed(0));
  check('the fall is gradual, not a step',
        closing(1.0 + env.releaseSeconds / 2) < open * 0.9 &&
        closing(1.0 + env.releaseSeconds / 2) > shut * 1.1);

  // The tail itself: it must start where the held buffer left off, or the join clicks.
  var held = Audio.applyVcf(words, RATE, kg, zone, 60, 100);
  var at = Math.round(1.0 * RATE);

  var tail = Audio.releaseTail(words, RATE, kg, zone, 60, 100, 1.0, at, null, 2.0);

  // Long enough to carry the LEVEL out, not merely the filter's own release - a filter
  // that has finished closing still has to keep making sound while the note fades.
  check('the tail lasts as long as the level was asked for',
        tail && Math.abs(tail.length - RATE * 2.0) < RATE * 0.02,
        tail ? (tail.length / RATE).toFixed(2) + 's of a requested 2.00s' : 'none');

  /*
   * The join. The tail is primed with the run-up so its filter carries the same history
   * the buffer it replaces does; without that priming this step is the click.
   *
   * Compared against the steps the signal makes on its own, because a sawtooth is nothing
   * but steps and an absolute threshold would say nothing.
   */
  var ordinary = 0;
  for (var k = at + 1; k < at + 2000; k++)
    ordinary = Math.max(ordinary, Math.abs(held[k] - held[k - 1]));

  var step = Math.abs(tail[0] - held[at - 1]);
  check('the tail joins without a step', step < ordinary * 1.5,
        step.toFixed(4) + ' against the waveform\'s own ' + ordinary.toFixed(4));

  /*
   * A release byte of zero is not "no release" - it is the filter snapping shut at once and
   * staying there while the level fades, which the held buffer does NOT sound like. So it
   * still gets a tail, and that tail is dark all the way through.
   */
  var snap = { vcf: [0, 99, 99, 0], vcfAmount: 50, vcfWritten: true,
               keyToFilter: 0, velToFilter: 0 };
  var snapped = Audio.releaseTail(words, RATE, snap, zone, 60, 100, 1.0, at, null, 2.0);

  function energy(x, from, to) {
    var s = 0;
    for (var i = from; i < to; i++) s += x[i] * x[i];
    return Math.sqrt(s / (to - from));
  }

  check('a release of zero still gets a tail', snapped && snapped.length > RATE,
        snapped ? snapped.length + ' samples' : 'none');

  // Past the first few milliseconds it is shut, where the gradual one is still open.
  check('and that tail is shut once it has closed',
        energy(snapped, 1000, RATE / 2) < energy(tail, 1000, RATE / 2) * 0.9,
        energy(snapped, 1000, RATE / 2).toFixed(4) + ' against ' +
        energy(tail, 1000, RATE / 2).toFixed(4));

  /*
   * And it closes without ringing.
   *
   * The fastest release drops the cutoff five and a half octaves in about a millisecond.
   * Retuning a sixth-order cascade that hard while it keeps its state makes it ring - at a
   * 64-sample step this peaked at 9.2, ten times full scale, which is a pop and not a filter.
   */
  var loudest = 0;
  for (var q = 0; q < snapped.length; q++) loudest = Math.max(loudest, Math.abs(snapped[q]));
  check('closing fast does not make the filter ring', loudest < 1.0, loudest.toFixed(3));

  // A keygroup whose envelope has no depth never moves the cutoff, so letting go changes
  // nothing about the filter and the buffer already playing is right.
  var flat = { vcf: [0, 99, 99, 60], vcfAmount: 0, vcfWritten: true,
               keyToFilter: 0, velToFilter: 0 };
  check('an envelope with no depth has no tail',
        Audio.releaseTail(words, RATE, flat, zone, 60, 100, 1.0, at, null, 2.0) === null);

  // An S900 programme has no filter envelope at all, so nothing to release.
  var s900 = { vcf: [32, 32, 32, 32], vcfAmount: 0, vcfWritten: false,
               keyToFilter: 0, velToFilter: 0 };
  check('an unwritten filter envelope has no release',
        Audio.releaseTail(words, RATE, s900, zone, 60, 100, 1.0, at, null, 2.0) === null);
}());

console.log('');
console.log(problems.length ? problems.length + ' FAILED' : 'all checks passed');
if (problems.length) process.exit(1);
