/*
 * The LFO calibration chain, against an S950 whose answers are known.
 *
 * There is no take yet - nobody has recorded one - so the way to know whether lfocal.js
 * measures what it claims is to build a machine that behaves in a way chosen in advance
 * and see whether the analysis finds that behaviour without being told it.
 *
 * The imaginary machine below has a rate that doubles every 20 units, a depth of 0.55
 * cents per unit, a delay of 45 ms per unit and a triangle LFO. None of those numbers is
 * a guess at what a real S950 does - they are simply numbers, chosen to be nothing like
 * round and nothing like each other, so that a reading which happens to be close cannot
 * be close by luck.
 *
 * The tone is rendered the way the sampler renders it: the very words lfodisk.js writes
 * to the disk, read out of a loop at a rate the LFO moves. So the test drives the real
 * generated audio, the real splitting, the real placement and the real report.
 *
 *   node test/lfotest.js
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var plan = require('../tools/lfoplan.js');
var lfodisk = require('../tools/lfodisk.js');
var lfocal = require('../tools/lfocal.js');

var fails = 0;

function check(what, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? '   ' + detail : ''));
  if (!ok) fails++;
}

function near(got, want, tol) { return isFinite(got) && Math.abs(got - want) <= tol; }

// ------------------------------------------------------- the imaginary machine

var MACHINE = {
  rateHz: function (byte) { return 0.4 * Math.pow(2, byte / 20); },
  depthCents: function (byte) { return 0.55 * byte; },
  delaySeconds: function (byte) { return 0.045 * byte; },
  // a triangle, starting at zero and rising - the phase matters for the desync test
  shape: function (t) { var u = (t % 1 + 1) % 1; return u < 0.25 ? 4 * u
                                              : u < 0.75 ? 2 - 4 * u : 4 * u - 4; },
  wheelCents: function (byte22, cc) { return 0.55 * 99 * (byte22 / 99) * (cc / 127); }
};

var OUT_RATE = 22050;         // the take's sample rate: lower than a real one, and enough

/**
 * Play a looped sample the way the sampler would, with the LFO moving the rate.
 *
 * `mod` is { hz, cents, delay, phase, amDb, steps }. `steps` is the modwheel: a list of
 * { at, cents } that replaces `cents` from that moment on.
 */
function play(words, srcRate, seconds, carrierRatio, mod) {
  var n = Math.round(seconds * OUT_RATE);
  var out = new Float64Array(n);
  var len = words.length;
  var pos = 0;
  var base = srcRate / OUT_RATE * carrierRatio;

  for (var i = 0; i < n; i++) {
    var t = i / OUT_RATE;

    var cents = mod.cents || 0;
    if (mod.steps) {
      for (var s = 0; s < mod.steps.length; s++) if (t >= mod.steps[s].at) cents = mod.steps[s].cents;
    }

    var on = (mod.delay || 0) <= 0 ? 1 : (t < mod.delay ? 0 : 1);
    var lfo = mod.hz ? MACHINE.shape((t - (mod.delay || 0)) * mod.hz + (mod.phase || 0)) * on : 0;

    var ratio = Math.pow(2, cents * lfo / 1200);
    var gain = mod.amDb ? Math.pow(10, (mod.amDb / 2) * lfo / 20) : 1;

    var at = Math.floor(pos), frac = pos - at;
    var a = words[at % len], b = words[(at + 1) % len];
    out[i] = gain * (a + (b - a) * frac) / 2048;

    pos += base * ratio;
    if (pos >= len) pos -= len;
  }
  return out;
}

var TONES = lfodisk.tones();

/* --- the disk, through the parser the app itself uses ----------------------- */
//
// lfodisk's own check reads the bytes it wrote back out of the file. That catches a
// builder that wrote to the wrong offset, but not a plan that named one - if both agree
// on byte 16 being the depth, both are wrong together. This asks akai.js instead, which
// is the code the editor and the emulation read a keygroup with, and which was written
// from the format document rather than from lfoplan.js.

console.log('');
console.log('the disk, read as the app reads it:');

var Akai = require('../akai.js');
var built = lfodisk.buildDisk('LFOCAL');
var reloaded = Akai.load('LFOCAL.img', built.save('img'));
var prog = reloaded.programsInOrder().filter(function (e) {
  return e.name.trim() === 'LFOCAL';
})[0];

check('the programme survives a save and a reload', !!prog, prog ? prog.name.trim() : 'missing');

var parsed = reloaded.keygroups(prog);
var wantKgs = plan.keygroups();
check('  with every keygroup', parsed.length === wantKgs.length,
      parsed.length + ' of ' + wantKgs.length);

var wrong = [];
wantKgs.forEach(function (spec, i) {
  var kg = parsed[i];
  if (!kg) { wrong.push('kg ' + (i + 1) + ' missing'); return; }
  if (kg.lfoDelay !== spec.set[15]) wrong.push('kg ' + (i + 1) + ' delay ' + kg.lfoDelay);
  if (kg.lfoRate !== spec.set[16]) wrong.push('kg ' + (i + 1) + ' rate ' + kg.lfoRate);
  if (kg.lfoDepth !== spec.set[17]) wrong.push('kg ' + (i + 1) + ' depth ' + kg.lfoDepth);
  if (kg.lfoDesync !== ((spec.set[18] & plan.FLAG_DESYNC) !== 0))
    wrong.push('kg ' + (i + 1) + ' desync ' + kg.lfoDesync);
  if (kg.lowKey !== spec.key || kg.highKey !== spec.key)
    wrong.push('kg ' + (i + 1) + ' keys ' + kg.lowKey + '..' + kg.highKey);
  if (kg.zone1.name.trim() !== spec.sample)
    wrong.push('kg ' + (i + 1) + ' plays ' + kg.zone1.name.trim());
});
check('  and every LFO setting the plan asked for', wrong.length === 0,
      wrong.length ? wrong.slice(0, 3).join('; ') : wantKgs.length + ' keygroups');

// No keygroup transposes anything. The first take of this run was ruined by asking for
// transposes of up to fourteen semitones - four times anything the library uses - so the
// pitch of a clip is now simply the pitch of its key, and the plan says what that is.
var transposed = parsed.filter(function (kg) { return kg.zone1.transpose !== 0; });
check('  with nothing transposed', transposed.length === 0,
      transposed.length ? transposed.length + ' zones carry a transpose' : 'all 0');

var mispitched = [];
parsed.forEach(function (kg) {
  var smp = reloaded.entries.filter(function (e) {
    return e.type === 'S' && e.name.trim() === kg.zone1.name.trim();
  })[0];
  var hz = plan.TONE_HZ * Math.pow(2, (kg.lowKey - smp.nominalPitch + kg.zone1.transpose) / 12);
  var spec = plan.TESTS.filter(function (t) { return t.key === kg.lowKey; })[0];
  if (Math.abs(1200 * Math.log2(hz / spec.sounds)) > 0.5)
    mispitched.push('key ' + kg.lowKey + ' would sound ' + hz.toFixed(1) +
                    ', the plan says ' + spec.sounds.toFixed(1));
});
check('  and every keygroup sounds at the pitch the plan tells the analysis to expect',
      mispitched.length === 0,
      mispitched.length ? mispitched.slice(0, 2).join('; ')
                        : parsed.length + ' keygroups, ' +
                          Math.min.apply(null, plan.TESTS.map(function (t) { return t.sounds; })).toFixed(0) +
                          ' to ' +
                          Math.max.apply(null, plan.TESTS.map(function (t) { return t.sounds; })).toFixed(0) + ' Hz');

// the desync pairs have to be exactly two octaves apart, or the tracker cannot put a
// null on one while reading the other
var pairs = plan.clips().filter(function (c) { return c.pairWith !== null; });
var ratios = pairs.map(function (c) {
  var up = plan.TESTS.filter(function (t) { return t.key === c.pairWith; })[0];
  return up.sounds / c.sounds;
});
check('  with the desync pairs exactly two octaves apart',
      ratios.length === 2 && ratios.every(function (r) { return Math.abs(r - 4) < 1e-9; }),
      ratios.map(function (r) { return r.toFixed(4); }).join(' and '));

/* --- the pieces, one at a time --------------------------------------------- */

console.log('');
console.log('reading one clip at a time:');

[[0.4, 12, 'SAW'], [3.2, 24, 'SAW'], [7.5, 55, 'SINE'], [12.4, 40, 'PULSE']].forEach(function (c) {
  var x = play(TONES[c[2]], lfodisk.RATE, 5, 1, { hz: c[0], cents: c[1] });
  var m = lfocal.measure(x, OUT_RATE, { from: 0, to: 5, sounds: plan.TONE_HZ }, 0);
  check(c[2] + ' at ' + c[0] + ' Hz, ' + c[1] + ' cents: rate',
        near(m.rate.hz, c[0], c[0] * 0.03), 'read ' + m.rate.hz.toFixed(3) + ' Hz');
  check('  and depth',
        near(m.depthCents, c[1], Math.max(1, c[1] * 0.04)),
        'read ' + m.depthCents.toFixed(2) + ' cents, from ' + m.depthFrom);
});

// a tone that is not modulated at all had better read as one
var flat = play(TONES.SAW, lfodisk.RATE, 5, 1, {});
var mf = lfocal.measure(flat, OUT_RATE, { from: 0, to: 5, sounds: plan.TONE_HZ }, 0);
check('an unmodulated tone reads as flat', mf.depthCents < 1.5,
      mf.depthCents.toFixed(3) + ' cents, ' + (mf.rate ? mf.rate.explains.toFixed(2) : '-') + ' explained');

// the pitch must not be invented out of a level that wobbles
var am = play(TONES.SAW, lfodisk.RATE, 5, 1, { hz: 3.2, cents: 0, amDb: 6 });
var ma = lfocal.measure(am, OUT_RATE, { from: 0, to: 5, sounds: plan.TONE_HZ }, 0);
check('a level that wobbles is not read as pitch', ma.depthCents < 1.5,
      ma.depthCents.toFixed(3) + ' cents, heard in the ' + ma.heardIn);
check('  and the level wobble is measured', near(ma.levelPeakDb, 6, 0.8),
      ma.levelPeakDb.toFixed(2) + ' dB of 6');

// the three waveforms have to agree with each other, or nothing else means anything
var reads = ['SAW', 'SINE', 'PULSE'].map(function (k) {
  var x = play(TONES[k], lfodisk.RATE, 5, 1, { hz: 3.2, cents: 30 });
  return lfocal.measure(x, OUT_RATE, { from: 0, to: 5, sounds: plan.TONE_HZ }, 0).depthCents;
});
check('saw, sine and pulse read the same depth',
      Math.max.apply(null, reads) - Math.min.apply(null, reads) < 1.5,
      reads.map(function (r) { return r.toFixed(2); }).join(' / ') + ' cents');

/* --- the shape ------------------------------------------------------------- */

console.log('');
console.log('the waveform:');

var slow = play(TONES.SAW, lfodisk.RATE, 16, 1, { hz: 0.8, cents: 55 });
var mshape = lfocal.measure(slow, OUT_RATE, { from: 0, to: 16, sounds: plan.TONE_HZ }, 0);
check('a triangle is named a triangle', mshape.shape[0].name === 'triangle',
      mshape.shape[0].name + ' at r ' + mshape.shape[0].r.toFixed(3) +
      ', then ' + mshape.shape[1].name);
check('  and it is a confident match', mshape.shape[0].r > 0.98,
      'r ' + mshape.shape[0].r.toFixed(4));

// the same machinery has to name a sine when it is given one, or naming a triangle
// proves nothing
var saved = MACHINE.shape;
MACHINE.shape = function (t) { return Math.sin(2 * Math.PI * t); };
var sineLfo = play(TONES.SAW, lfodisk.RATE, 16, 1, { hz: 0.8, cents: 55 });
MACHINE.shape = saved;
var msine = lfocal.measure(sineLfo, OUT_RATE, { from: 0, to: 16, sounds: plan.TONE_HZ }, 0);
check('and a sine is named a sine', msine.shape[0].name === 'sine',
      msine.shape[0].name + ' at r ' + msine.shape[0].r.toFixed(3));

/* --- the delay ------------------------------------------------------------- */

console.log('');
console.log('the delay:');

[1.125, 2.25, 4.455].forEach(function (d) {
  var x = play(TONES.SAW, lfodisk.RATE, 12, 1, { hz: 3.2, cents: 54, delay: d });
  var m = lfocal.measure(x, OUT_RATE, { from: 0, to: 12, sounds: plan.TONE_HZ },
                         0, { skipSeconds: 0.02, steadyFrom: 7 });
  var on = lfocal.onset(m.track.cents, 0, m.track.cents.length, m.rate.hz, m.track.frameRate);
  check('a wait of ' + d + 's is found', near(on.at50, d, 0.35),
        'read ' + on.at50.toFixed(2) + 's');
});

/* --- two voices at once ---------------------------------------------------- */

console.log('');
console.log('two voices in one recording:');

// the desync clip: the tone and two octaves above it together, the second a quarter
// cycle behind
var lower = play(TONES.SINE, lfodisk.RATE, 6, 1, { hz: 3.2, cents: 54, phase: 0 });
var upper = play(TONES.SINE, lfodisk.RATE, 6, 4, { hz: 3.2, cents: 54, phase: 0.25 });
var both = new Float64Array(lower.length);
for (var i = 0; i < both.length; i++) both[i] = (lower[i] + upper[i]) / 2;

var LO = plan.TONE_HZ, HI = plan.TONE_HZ * 4;
var tl = lfocal.demodulate(both, OUT_RATE, 0, both.length, LO, LO);
var tu = lfocal.demodulate(both, OUT_RATE, 0, both.length, HI, LO);
check('the lower voice is found alone', near(tl.carrier, LO, 3), tl.carrier.toFixed(1) + ' Hz');
check('the upper voice is found alone', near(tu.carrier, HI, 6), tu.carrier.toFixed(1) + ' Hz');

var rl = lfocal.findRate(tl.cents, 0, tl.cents.length, tl.frameRate);
var bl = lfocal.bin(tl.cents, rl.from, rl.to, rl.hz, tl.frameRate);
var bu = lfocal.bin(tu.cents, rl.from, rl.to, rl.hz, tu.frameRate);
var deg = (bu.phase - bl.phase) * 180 / Math.PI;
while (deg > 180) deg -= 360;
while (deg < -180) deg += 360;

// bin returns the fundamental, and the LFO here is a triangle, whose fundamental is
// 8/pi^2 of its peak - the same conversion the report makes
var crest = lfocal.SHAPES.triangle.crest;
check('each voice keeps its own depth',
      near(bl.amp / crest, 54, 3) && near(bu.amp / crest, 54, 3),
      (bl.amp / crest).toFixed(1) + ' and ' + (bu.amp / crest).toFixed(1) + ' cents');
check('and a quarter cycle between them is measured as one',
      near(Math.abs(deg), 90, 15), deg.toFixed(0) + ' degrees');

/* --- the MIDI file --------------------------------------------------------- */
//
// Parsed here rather than trusted, because the bugs available in a MIDI file are quiet
// ones - a variable-length quantity encoded wrongly shifts every later event, a missing
// note-off leaves a note hanging - and none of them shows up until an afternoon of
// recording has already been spent.

console.log('');
console.log('the MIDI file:');

var midi = path.join(__dirname, '..', 'tools', 'AkaiLfoCalibration.mid');
if (!fs.existsSync(midi)) {
  check('AkaiLfoCalibration.mid exists', false, 'run: node tools/lfomidi.js');
} else {
  var b2 = fs.readFileSync(midi);
  var pos = 0;
  function vlq() { var v = 0, byte; do { byte = b2[pos++]; v = (v << 7) | (byte & 0x7F); } while (byte & 0x80); return v; }

  check('starts with MThd', b2.toString('ascii', 0, 4) === 'MThd');
  var division = b2.readUInt16BE(12);
  check('format 0, one track', b2.readUInt16BE(8) === 0 && b2.readUInt16BE(10) === 1);

  pos = 8 + b2.readUInt32BE(4);
  check('track starts with MTrk', b2.toString('ascii', pos, pos + 4) === 'MTrk');
  var trackLen = b2.readUInt32BE(pos + 4);
  check('  and its length matches the file', pos + 8 + trackLen === b2.length,
        'says ' + trackLen + ', file has ' + (b2.length - pos - 8));

  pos += 8;
  var end = pos + trackLen, tick = 0, running = 0, heard = [], usec = 500000;
  while (pos < end) {
    tick += vlq();
    var st = b2[pos];
    if (st & 0x80) { running = st; pos++; } else { st = running; }
    var at = tick / division * (usec / 1e6);
    if (st === 0xFF) {
      var type = b2[pos++], len = vlq();
      if (type === 0x51) usec = (b2[pos] << 16) | (b2[pos + 1] << 8) | b2[pos + 2];
      pos += len;
    } else if ((st & 0xF0) === 0x90) {
      heard.push({ at: at, kind: b2[pos + 1] ? 'on' : 'off', note: b2[pos], value: b2[pos + 1] }); pos += 2;
    } else if ((st & 0xF0) === 0x80) {
      heard.push({ at: at, kind: 'off', note: b2[pos], value: b2[pos + 1] }); pos += 2;
    } else if ((st & 0xF0) === 0xB0) {
      heard.push({ at: at, kind: 'cc', controller: b2[pos], value: b2[pos + 1] }); pos += 2;
    } else {
      pos += 2;
    }
  }

  var want = plan.schedule().events;
  check('every event the plan asks for is in the file', heard.length === want.length,
        heard.length + ' of ' + want.length);

  var mismatched = [];
  want.forEach(function (e, i) {
    var g = heard[i];
    if (!g) { mismatched.push('#' + i + ' missing'); return; }
    if (Math.abs(g.at - e.at) > 0.002) mismatched.push('#' + i + ' at ' + g.at.toFixed(3) + ', wanted ' + e.at.toFixed(3));
    else if (g.kind !== e.kind) mismatched.push('#' + i + ' is a ' + g.kind + ', wanted ' + e.kind);
    else if (e.kind !== 'cc' && g.note !== e.note) mismatched.push('#' + i + ' note ' + g.note + ', wanted ' + e.note);
    else if (e.kind === 'cc' && g.value !== e.value) mismatched.push('#' + i + ' cc ' + g.value + ', wanted ' + e.value);
  });
  check('  at the time and on the note the plan says', mismatched.length === 0,
        mismatched.length ? mismatched.slice(0, 3).join('; ') : want.length + ' events');

  var held = {};
  heard.forEach(function (e) {
    if (e.kind === 'on') held[e.note] = (held[e.note] || 0) + 1;
    if (e.kind === 'off') held[e.note] = (held[e.note] || 0) - 1;
  });
  check('  and no note is left hanging',
        Object.keys(held).every(function (k) { return held[k] === 0; }),
        Object.keys(held).filter(function (k) { return held[k] !== 0; }).join(', ') || 'all released');

  var lastWheel = heard.filter(function (e) { return e.kind === 'cc'; }).pop();
  check('  and the wheel is put back where it was found',
        !!lastWheel && lastWheel.value === 0,
        lastWheel ? 'ends at ' + lastWheel.value : 'no controller events');
}

/* --- the whole run --------------------------------------------------------- */
//
// Everything above reads a clip it was handed. This builds the take: the whole 256
// seconds, every clip the plan asks for, at the settings the plan asks for, with a
// recording that started a moment before the run did - and then hands lfocal a WAV file
// and nothing else, exactly as a real afternoon would.

console.log('');
console.log('the whole run, end to end:');

var run = plan.schedule();
var START = 0.63;                      // the recorder was running before the sequencer
var total = Math.round((run.seconds + START + 1) * OUT_RATE);
var take = new Float64Array(total);

function put(at, x) {
  var from = Math.round(at * OUT_RATE);
  for (var i = 0; i < x.length && from + i < total; i++) take[from + i] += x[i];
}

run.clips.forEach(function (c) {
  var kg = plan.TESTS.filter(function (t) { return t.key === c.note; })[0];
  var mod = {
    hz: MACHINE.rateHz(kg.set[16]),
    cents: MACHINE.depthCents(kg.set[17]),
    delay: MACHINE.delaySeconds(kg.set[15])
  };

  // the modwheel clips carry no depth of their own; the wheel supplies all of it
  if (c.cc) {
    mod.cents = 0;
    mod.steps = c.cc.map(function (s) {
      return { at: s.at, cents: MACHINE.wheelCents(kg.set[22], s.value) };
    });
  }

  // each clip sounds at its own key's pitch now, which is what the sampler does with a
  // zone that transposes nothing
  put(c.from + START, play(TONES[c.sample], lfodisk.RATE, c.hold,
                           c.sounds / plan.TONE_HZ, mod));

  if (c.pairWith !== null && c.pairWith !== undefined) {
    var pk = plan.TESTS.filter(function (t) { return t.key === c.pairWith; })[0];
    // desync off shares one LFO across the programme, so the second voice joins it
    // already in progress; desync on gives the voice its own, starting at zero
    var shared = (pk.set[18] & plan.FLAG_DESYNC) === 0;
    put(c.from + START + c.stagger,
        play(TONES[pk.sample], lfodisk.RATE, c.hold, pk.sounds / plan.TONE_HZ,
             { hz: mod.hz, cents: mod.cents,
               phase: shared ? (c.stagger * mod.hz) % 1 : 0 }));
  }
});

var wav = path.join(os.tmpdir(), 'lfotest-take.wav');
writeWav(wav, take, OUT_RATE);
console.log('  wrote ' + (take.length / OUT_RATE).toFixed(0) + 's to ' + wav);

var r = lfocal.analyse(wav);
try { fs.unlinkSync(wav); } catch (e) { /* a leftover temp file is not a failure */ }

console.log('what the report got right:');
check('every clip was found', r && r.found === run.clips.length,
      r ? r.found + ' of ' + run.clips.length : 'no report');
check('the run was placed against the plan', r && near(r.offset, START, 0.1),
      r ? 'offset ' + r.offset.toFixed(2) + 's, wanted ' + START : '-');
check('  and every clip matched where it should be', r && r.matched === run.clips.length,
      r ? r.matched + ' of ' + run.clips.length : '-');

// The guard the first real take showed was missing.
check('  and every clip played the pitch it was asked for', r && r.wrongPitch === 0,
      r ? r.wrongPitch + ' clips off pitch' : '-');

// A check that cannot fail is not a check. This is what the first take actually looked
// like: a tone three octaves from where it was asked to be, which the analysis used to
// swallow whole and report a depth for.
var wrongPitch = play(TONES.SAW, lfodisk.RATE, 5, 8, { hz: 3.2, cents: 30 });
var mw2 = lfocal.measure(wrongPitch, OUT_RATE,
                         { from: 0, to: 5, sounds: plan.TONE_HZ, label: 'three octaves up' }, 0);
check('  and a clip three octaves off is refused rather than measured',
      !mw2.trustworthy,
      'off pitch ' + mw2.offPitch + ', unsteady ' + mw2.unsteady +
      ', read ' + mw2.meanHz.toFixed(0) + ' Hz where ' + plan.TONE_HZ + ' was asked for');

// and one that is merely mistuned, not lost - a quarter tone out is still the right note
var slightlyOff = play(TONES.SAW, lfodisk.RATE, 5, Math.pow(2, 0.5 / 12), { hz: 3.2, cents: 30 });
var ms2 = lfocal.measure(slightlyOff, OUT_RATE,
                         { from: 0, to: 5, sounds: plan.TONE_HZ, label: 'half a semitone up' }, 0);
check('  while half a semitone out is still accepted', ms2.trustworthy,
      ms2.centsOffNominal.toFixed(0) + ' cents off, depth ' + ms2.depthCents.toFixed(1));

var rateBad = (r.rate || []).filter(function (p) {
  return !p.ok || !near(p.hz, MACHINE.rateHz(p.setting), MACHINE.rateHz(p.setting) * 0.04);
});
check('the rate ladder came back', rateBad.length === 0,
      (r.rate.length - rateBad.length) + ' of ' + r.rate.length + ' within 4%' +
      (rateBad.length ? ': ' + rateBad.map(function (p) { return 'rate ' + p.setting; }).join(', ') : ''));

// The law itself, which is what would actually be pasted into audio.js. This machine
// doubles every 20 units, so the analysis has to say EXPONENTIAL and recover the doubling
// - where the real S950, measured, turned out to be linear in hertz. Getting the right
// answer for a machine that behaves the other way is the point of the test.
check('the rate law is recognised as exponential', r.rateLaw === 'exponential',
      (r.rateLaw || '-') + ': hertz r2 ' + (r.rateFit ? r.rateFit.r2.toFixed(5) : '-') +
      ', log2 r2 ' + (r.rateLogFit ? r.rateLogFit.r2.toFixed(5) : '-'));
check('  and the doubling is recovered',
      r.rateLogFit && near(Math.pow(2, r.rateLogFit.slope * 20), 2, 0.08),
      r.rateLogFit ? 'doubles every ' + (1 / r.rateLogFit.slope).toFixed(1) +
                     ' units, built to double every 20' : '-');

check('the depth law is recovered',
      r.depthFit && near(r.depthFit.slope, 0.55, 0.04),
      r.depthFit ? r.depthFit.slope.toFixed(3) + ' cents per unit, built as 0.55' : '-');
check('  and it passes through zero',
      r.depthFit && Math.abs(r.depthFit.intercept) < 3,
      r.depthFit ? 'intercept ' + r.depthFit.intercept.toFixed(2) + ' cents' : '-');

check('the delay law is recovered',
      r.delayFit && near(r.delayFit.slope, 0.045, 0.006),
      r.delayFit ? r.delayFit.slope.toFixed(4) + ' s per unit, built as 0.045' : '-');

check('the shape is named', !!(r.shape && r.shape.shape && r.shape.shape[0].name === 'triangle'),
      r.shape && r.shape.shape ? r.shape.shape[0].name : '-');

check('it says the LFO moves pitch and not level',
      r.what && Math.abs(r.what.levelPeakDb) < 0.7,
      r.what ? r.what.levelPeakDb.toFixed(2) + ' dB of level movement' : '-');

check('the pulse agrees with the sawtooth at the same setting',
      r.timbre && near(r.timbre.depthCents, MACHINE.depthCents(60), 2),
      r.timbre ? r.timbre.depthCents.toFixed(2) + ' cents, wanted ' +
                 MACHINE.depthCents(60).toFixed(2) : '-');

var wheelTop = r.wheel && r.wheel.length ? r.wheel[r.wheel.length - 1] : null;
check('the modwheel curve came back',
      wheelTop && near(wheelTop.cents, MACHINE.wheelCents(99, 127), 5),
      wheelTop ? 'wheel ' + wheelTop.cc + ' read ' + wheelTop.cents.toFixed(1) +
                 ' cents, wanted ' + MACHINE.wheelCents(99, 127).toFixed(1) : '-');
check('  and the wheel at byte 22 = 50 is about half of it',
      r.wheelHalf && near(r.wheelHalf.depthCents, MACHINE.wheelCents(50, 127), 5),
      r.wheelHalf ? r.wheelHalf.depthCents.toFixed(1) + ' cents, wanted ' +
                    MACHINE.wheelCents(50, 127).toFixed(1) : '-');

// the machine above was built so that desync off shares a phase and desync on does not,
// which is the thing the section exists to tell apart
var off = (r.desync || []).filter(function (d) { return /off/.test(d.label); })[0];
var on = (r.desync || []).filter(function (d) { return /on/.test(d.label); })[0];
check('desync on and desync off are told apart',
      off && on && Math.abs(off.degrees) < 25 && Math.abs(on.degrees) > 40,
      off && on ? 'off ' + off.degrees.toFixed(0) + ' deg, on ' + on.degrees.toFixed(0) + ' deg' : '-');

/* --- a WAV writer, so the test can hand lfocal a file ---------------------- */

function writeWav(file, x, rate) {
  var n = x.length;
  var b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);                 // PCM
  b.writeUInt16LE(1, 22);                 // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(n * 2, 40);
  for (var i = 0; i < n; i++) {
    var v = Math.max(-1, Math.min(1, x[i]));
    b.writeInt16LE(Math.round(v * 32000), 44 + i * 2);
  }
  fs.writeFileSync(file, b);
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);
