/*
 * Read one filter envelope take and settle what it can.
 *
 *   node envcal.js <take.wav> [disk image]
 *
 * The take is the 19 notes of AkaiEnvCalibration.mid played through ENVCAL. Every clip is
 * placed on the plan's own timeline rather than counted, so a note that fails to sound
 * costs one measurement instead of the whole take.
 *
 * Every measurement divides out the NOISE sample, which envdisk.js generates from a fixed
 * seed and which sits bit-exact in the image - so the source spectrum, the level of each
 * clip and whatever the recording chain added all cancel, and only the sampler's own
 * shaping is left.
 */
var fs = require('fs');
var cal = require('./vcfcal.js');
/*
 * Which run this is for.
 *
 * --plan envplan2.js points the tool at the second run. Without it the first one is used,
 * and that matters: a take already recorded has to stay analysable after the plan has moved
 * on, or the recording becomes the only copy of what it measured.
 */
var args = process.argv.slice(2);
var planFile = './envplan.js';
for (var ai = 0; ai < args.length; ai++) {
  if (args[ai] === '--plan') { planFile = './' + args[ai + 1].split(/[/]/).pop(); args.splice(ai, 2); break; }
}
var plan = require(planFile);
var Akai = require('../akai.js');
var Audio = require('../audio.js');

var file = args[0];
var image = args[1] || require('path').join(__dirname, 'ENVCAL.img');

if (!file) {
  console.log('usage: node envcal.js <take.wav> [disk image]');
  process.exit(1);
}

// ---------------------------------------------------------------- the source

var disk = Akai.load('x', new Uint8Array(fs.readFileSync(image)));
var smp = null;
disk.entries.forEach(function (e) { if (e.type === 'S' && e.name.trim() === 'NOISE') smp = e; });
if (!smp) { console.log('no NOISE sample in ' + image); process.exit(1); }

var words = disk.sampleWords12(smp);
var source = new Float64Array(words.length);
for (var i = 0; i < words.length; i++) source[i] = words[i] / 2048;
var srcSpec = cal.spectrum(source, smp.sampleRate, cal.BANDS);

var CEILING = Audio.CAL.MAX_RATIO * smp.sampleRate;
var FLOOR = Audio.CAL.FLOOR_HZ;

// ------------------------------------------------------------------ the take

var w = cal.readWav(file);
var run = plan.schedule();
var wanted = run.clips;

var found = cal.splitClips(w.samples, w.rate, wanted.length,
                           { minGapSeconds: plan.TIMING.gap * 0.5 });

/*
 * Place what was found on the timeline the plan wrote, rather than counting clips.
 *
 * The only unknown is when recording started, and that is one constant for the whole take -
 * so try every offset that would line some found clip up with some expected one, and keep
 * whichever explains the most. See benchcal.js, where the same thing is done for the same
 * reason.
 */
function align() {
  var starts = found.clips.map(function (c) { return c.seconds[0]; });
  var tol = plan.TIMING.gap * 0.6;
  var best = { score: -1, map: null, offset: 0 };

  starts.forEach(function (s0) {
    wanted.forEach(function (c0) {
      var off = s0 - c0.from, used = {}, map = [], score = 0;

      wanted.forEach(function (c) {
        var pick = -1, near = tol;
        starts.forEach(function (s, j) {
          if (used[j]) return;
          var d = Math.abs(s - (c.from + off));
          if (d < near) { near = d; pick = j; }
        });
        if (pick >= 0) { used[pick] = true; score++; }
        map.push(pick);
      });

      if (score > best.score) best = { score: score, map: map, offset: off };
    });
  });
  return best;
}

var placed = align();
var slot = placed.map;

/*
 * Say what is actually wrong with a take that cannot be read.
 *
 * "only -1 of 14 clips could be placed" is what this used to print for a recording with no
 * instrument in it at all, which is a sentence about the aligner rather than about the
 * take. The two failures want telling apart: nothing recorded, and something recorded that
 * does not match the plan.
 */
if (found.clips.length === 0) {
  var quiet = found.peakDb.toFixed(1);
  console.log('');
  console.log('nothing to measure: the loudest moment in ' +
              (w.samples.length / w.rate).toFixed(0) + 's is ' + quiet + ' dBFS, and the ' +
              'quiet between notes is only ' + found.floorDb.toFixed(0) + ' dB below it.');
  console.log('');
  console.log(found.peakDb < -40
    ? 'That is a recording of silence rather than a quiet recording - the transport ran but\n' +
      'the sampler did not reach it. Check the programme is selected and play a key by hand.'
    : 'There is signal but no gaps, so the notes cannot be told apart. Check this is the\n' +
      'whole run and not a loop of part of it.');
  console.log('');
  process.exit(1);
}

if (placed.score < 2) {
  console.log('');
  console.log('found ' + found.clips.length + ' clips but only ' + Math.max(0, placed.score) +
              ' of them land where the plan puts a note.');
  console.log('The take has to be the whole run, in order, from the same plan the disk was ' +
              'built from.');
  console.log('');
  process.exit(1);
}

/*
 * When each note really began, found from the audio.
 *
 * Not from the clip edges: the splitter looks for a run of sound rather than an edge and
 * reports a note about 0.3 s after it started. That is harmless for a steady corner and
 * fatal for the release section, which is timed from the note coming up.
 */
function onsetNear(when) {
  var frame = Math.max(64, Math.round(w.rate * 0.01));
  var from = Math.max(0, Math.round((when - 1.0) * w.rate));
  var to = Math.min(w.samples.length, Math.round((when + 1.0) * w.rate));

  var levels = [];
  for (var at = from; at + frame <= to; at += frame) {
    var sum = 0;
    for (var j = 0; j < frame; j++) { var v = w.samples[at + j]; sum += v * v; }
    levels.push(Math.sqrt(sum / frame));
  }
  if (levels.length < 8) return null;

  var sorted = levels.slice().sort(function (x, y) { return x - y; });
  var quiet = sorted[Math.floor(sorted.length * 0.2)];
  var loud = sorted[sorted.length - 1];
  if (loud <= quiet * 2) return null;

  var bar = Math.max(quiet * 3, loud * 0.02);
  for (var k = 0; k < levels.length; k++) if (levels[k] > bar) return (from + k * frame) / w.rate;
  return null;
}

var offsets = [];
wanted.forEach(function (c, i) {
  if (slot[i] < 0) return;
  var on = onsetNear(c.from + placed.offset);
  if (on !== null) offsets.push(on - c.from);
});
offsets.sort(function (a, b) { return a - b; });
var startedAt = offsets.length ? offsets[Math.floor(offsets.length / 2)] : placed.offset;

console.log('');
console.log('take: ' + (w.samples.length / w.rate).toFixed(1) + 's at ' + w.rate + ' Hz, ' +
            placed.score + ' of ' + wanted.length + ' clips, peak ' +
            found.peakDb.toFixed(1) + ' dBFS');
console.log('      notes begin ' + startedAt.toFixed(2) + 's from where the plan puts them');

wanted.forEach(function (c, i) {
  if (slot[i] < 0)
    console.log('  no clip for ' + c.section + ' / ' + c.label + ' (note ' + c.note +
                ') at ' + (c.from + startedAt).toFixed(1) + 's');
});

// ------------------------------------------------------------------ measuring

/**
 * The -3 dB corner of a stretch of audio, against the known source.
 *
 * Which bands count as passband depends on where the corner lands, so it is found once
 * against the bottom of the spectrum and then again levelled well below that: a fixed
 * window levels on the roll-off whenever the corner is low, and reads high.
 */
/*
 * The passband is levelled against a FIXED low reference, not one that follows the corner.
 *
 * benchcal.js levels twice - roughly, then again well below whatever the first pass found -
 * because on a long clip a fixed window can sit on the roll-off when the corner is low and
 * read high. That is the right answer there and the wrong one here. The release trace reads
 * windows of a twelfth of a second, and over 3500 samples the bands below a kilohertz are
 * too noisy to average: levelling across all of them turned a corner of 3438 Hz into 573.
 *
 * The lowest bands are safe for every measurement this run makes. Nothing here is ever
 * asked to close below the 311 Hz floor, so 80 to 150 Hz is passband in every clip, and a
 * reference taken from exactly there needs no second guess.
 */
var REFERENCE_TOP = 150;

function corner(samples) {
  if (!samples || samples.length < 2048) return null;
  var spec = cal.spectrum(samples, w.rate, cal.BANDS);

  var ref = 0, n = 0;
  for (var j = 0; j < cal.BANDS.length; j++)
    if (cal.BANDS[j] < REFERENCE_TOP) { ref += spec[j].db - srcSpec[j].db; n++; }
  if (n < 3) { ref = 0; for (var j2 = 0; j2 < 3; j2++) ref += spec[j2].db - srcSpec[j2].db; n = 3; }
  ref /= n;

  for (var k = 1; k < cal.BANDS.length; k++) {
    var a = (spec[k - 1].db - srcSpec[k - 1].db) - ref;
    var b = (spec[k].db - srcSpec[k].db) - ref;
    if (b <= -3 && a > -3) {
      var t = (a + 3) / (a - b);
      return cal.BANDS[k - 1] * Math.pow(cal.BANDS[k] / cal.BANDS[k - 1], t);
    }
  }
  return null;
}

/*
 * The source's own level at one frequency, interpolated between the bands it was measured
 * at. The probes the release section watches are not on the band grid, and dividing by the
 * source is what makes every measurement here independent of what the noise happens to be.
 */
function srcAt(hz) {
  if (hz <= cal.BANDS[0]) return srcSpec[0].db;
  for (var i = 1; i < cal.BANDS.length; i++) {
    if (cal.BANDS[i] < hz) continue;
    var t = Math.log(hz / cal.BANDS[i - 1]) / Math.log(cal.BANDS[i] / cal.BANDS[i - 1]);
    return srcSpec[i - 1].db + t * (srcSpec[i].db - srcSpec[i - 1].db);
  }
  return srcSpec[srcSpec.length - 1].db;
}

function rms(x) {
  if (!x || !x.length) return 0;
  var s = 0;
  for (var i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/** A stretch of a note, in seconds from when it began. */
function during(i, fromSeconds, toSeconds) {
  if (slot[i] < 0) return null;
  var begins = wanted[i].from + startedAt;
  var a = Math.max(0, Math.round((begins + fromSeconds) * w.rate));
  var b = Math.min(w.samples.length, Math.round((begins + toSeconds) * w.rate));
  return b > a ? w.samples.subarray(a, b) : null;
}

/**
 * The steady corner of a held clip.
 *
 * Measured over the middle of the note - past the attack, before the key comes up - and
 * over a long window, which is what makes a static corner the most reliable thing this rig
 * reads. Anything near a stop is reported as such rather than as a number, because a clip
 * against the ceiling says only that the envelope asked for at least that much.
 */
function steady(i) {
  var hz = corner(during(i, 0.3, wanted[i].hold - 0.2));
  if (hz === null) return null;

  return {
    hz: hz,
    atCeiling: hz > CEILING * 0.96,
    atFloor: hz < FLOOR * 1.04
  };
}

function say(label, m) {
  if (m === null) return console.log('     ' + label + '   not found');
  console.log('     ' + label + '   ' + m.hz.toFixed(0).padStart(6) + ' Hz' +
              (m.atCeiling ? '   (against the ceiling - a lower bound)'
                           : m.atFloor ? '   (on the floor - a lower bound)' : ''));
}

// group the clips by the analysis that asked for them
var sections = {};
wanted.forEach(function (c, i) {
  var s = sections[c.analysis] || (sections[c.analysis] = { at: [], missing: [] });
  (slot[i] >= 0 ? s.at : s.missing).push(i);
});

var result = {};

// ------------------------------------------------------- 1. the cutoff curve
if (sections.curve && sections.curve.at.length) {
  console.log('');
  console.log('CUTOFF CURVE  -  the settings the CAL table interpolates through');
  console.log('   stored    measured      table says');

  var points = [];
  sections.curve.at.forEach(function (i) {
    var m = steady(i);
    var stored = wanted[i].setting;
    var model = Audio.cutoffHz(stored, smp.sampleRate);

    console.log('     ' + String(stored).padStart(3) + '     ' +
                (m ? m.hz.toFixed(0).padStart(6) + ' Hz' : '  not found') +
                '     ' + model.toFixed(0).padStart(6) + ' Hz' +
                (m ? '   ' + (m.hz / model).toFixed(3) + 'x' : ''));

    if (m) points.push({ stored: stored, hz: m.hz, model: model });
  });

  if (points.length) {
    var worst = 0, at = 0;
    points.forEach(function (p) {
      var oct = Math.abs(Math.log2(p.hz / p.model));
      if (oct > worst) { worst = oct; at = p.stored; }
    });
    console.log('');
    console.log('   the table is out by at most ' + worst.toFixed(2) +
                ' octaves, at stored ' + at);
    result.curve = points;
  }
}

/*
 * The depth of an envelope, from a clip that holds it open.
 *
 * Both directions are fitted the same way: octaves moved against the amount asked for, a
 * straight line through the origin, and the slope times 50 is ENV_OCTAVES. Points against a
 * stop are dropped - they are the reason the first attempt at this measurement had to be
 * recovered from a sweep instead.
 */
function depth(which, at, base, title) {
  console.log('');
  console.log(title);

  var baseHz = Audio.cutoffHz(base, smp.sampleRate);
  console.log('   base is stored ' + base + ', ' + baseHz.toFixed(0) + ' Hz');
  console.log('   amount    corner        octaves from base');

  var usable = [];
  at.forEach(function (i) {
    var m = steady(i);
    var a = wanted[i].setting;

    if (m === null) { console.log('     ' + String(a).padStart(4) + '     not found'); return; }

    var oct = Math.log2(m.hz / baseHz);
    console.log('     ' + String(a).padStart(4) + '   ' + m.hz.toFixed(0).padStart(6) + ' Hz' +
                '      ' + (oct >= 0 ? '+' : '') + oct.toFixed(2) +
                (m.atCeiling ? '   against the ceiling' : m.atFloor ? '   on the floor' : ''));

    if (!m.atCeiling && !m.atFloor) usable.push({ a: a, oct: oct });
  });

  if (usable.length < 2) {
    console.log('   too few points clear of a stop to fit a depth');
    return null;
  }

  /*
   * Fitted WITH an intercept, not forced through the origin.
   *
   * Forcing it through zero looks principled - no amount should mean no movement - and it
   * is how this was first written, and it gave the wrong answer twice over. The first step
   * away from zero is short in both directions, so a line through the origin comes out
   * shallow; and how shallow depends on how many points each side happened to keep, which
   * made a symmetric filter read as 6% asymmetric purely because the closing side had
   * dropped a point for sitting on the floor.
   *
   * The slope is what ENV_OCTAVES is. Where the line crosses zero is a separate fact about
   * the machine - a dead zone near no-amount - and it is reported rather than assumed away.
   */
  var n = usable.length, sa = 0, so = 0, saa = 0, sao = 0;
  usable.forEach(function (p) { sa += p.a; so += p.oct; saa += p.a * p.a; sao += p.a * p.oct; });

  var perUnit = (n * sao - sa * so) / (n * saa - sa * sa);
  var intercept = (so - perUnit * sa) / n;
  var deadZone = perUnit !== 0 ? -intercept / perUnit : 0;

  var worst = 0;
  usable.forEach(function (p) {
    worst = Math.max(worst, Math.abs(p.oct - (perUnit * p.a + intercept)));
  });

  // the step from one amount to the next, which is the slope with nothing assumed at all
  var steps = [];
  for (var k = 1; k < usable.length; k++)
    steps.push((usable[k].oct - usable[k - 1].oct) / (usable[k].a - usable[k - 1].a));

  console.log('');
  console.log('   step by step: ' + steps.map(function (s) { return s.toFixed(3); }).join('  ') +
              '  octaves per unit');
  console.log('   ' + Math.abs(perUnit).toFixed(4) + ' octaves per unit fitted,  so ENV_OCTAVES is ' +
              Math.abs(perUnit * 50).toFixed(2));
  console.log('   it starts moving at an amount of ' + Math.abs(deadZone).toFixed(1) +
              ', not at zero');
  console.log('   worst departure from that line: ' + worst.toFixed(3) + ' octaves' +
              (worst < 0.15 ? '  (straight)' : '  - NOT straight'));

  result[which] = {
    perUnit: perUnit, envOctaves: Math.abs(perUnit * 50),
    deadZone: Math.abs(deadZone), points: usable
  };
  return result[which];
}

/*
 * The controls: the same cutoff at five keys with the key unable to reach the filter.
 *
 * They must all read the same number. Constant pitch means the sample plays identically
 * whatever is struck, and keyToFilter at nothing means the key cannot touch the cutoff - so
 * a spread here is something in the rig depending on the note, and every tracking figure
 * would be built on top of it.
 */
var controlHz = null;

if (sections.control && sections.control.at.length) {
  console.log('');
  console.log('NO TRACKING  -  the same setting at five keys, with the key disconnected');
  console.log('    note     corner');

  var flat = [];
  sections.control.at.forEach(function (i) {
    var m = steady(i);
    console.log('     ' + String(wanted[i].setting).padStart(3) + '   ' +
                (m ? m.hz.toFixed(0).padStart(6) + ' Hz' : '  not found'));
    if (m) flat.push({ note: wanted[i].setting, hz: m.hz });
  });

  if (flat.length >= 2) {
    var lo = Math.min.apply(null, flat.map(function (p) { return p.hz; }));
    var hi = Math.max.apply(null, flat.map(function (p) { return p.hz; }));
    controlHz = flat.reduce(function (a, p) { return a + p.hz; }, 0) / flat.length;

    console.log('');
    console.log('   they average ' + controlHz.toFixed(0) + ' Hz and spread ' +
                Math.log2(hi / lo).toFixed(3) + ' octaves');
    console.log(Math.log2(hi / lo) < 0.06
      ? '   flat, as they must be - the key reaches nothing when it is turned off'
      : '   NOT flat - something here depends on the note besides the tracking, and every ' +
        'tracking figure below rests on this being wrong');

    console.log('   the model says stored ' + plan.TRACK_FILTER + ' is ' +
                Audio.cutoffHz(plan.TRACK_FILTER, smp.sampleRate).toFixed(0) + ' Hz');
    result.control = controlHz;
  }
}

/*
 * Tracking: the same setting again, with the key connected.
 *
 * The slope says how far the cutoff moves per octave of keyboard, which the earlier run
 * already measured at 0.99. What is new is the PIVOT - the note at which tracking adds
 * nothing - which the model assumes is 60 and which nothing has ever tested. If it is not
 * 60, then every cutoff read from a keygroup with tracking on has been offset, including
 * the one that put 1878 Hz in the table for stored 50.
 */
if (sections.tracking && sections.tracking.at.length) {
  console.log('');
  console.log('TRACKING 50  -  the same setting, with the key connected');
  console.log('    note     corner      octaves from the controls');

  var pts = [];
  sections.tracking.at.forEach(function (i) {
    var m = steady(i);
    var note = wanted[i].setting;
    var oct = (m && controlHz) ? Math.log2(m.hz / controlHz) : null;

    console.log('     ' + String(note).padStart(3) + '   ' +
                (m ? m.hz.toFixed(0).padStart(6) + ' Hz' : '  not found') +
                (oct !== null ? '      ' + (oct >= 0 ? '+' : '') + oct.toFixed(2) : '') +
                (m && m.atCeiling ? '   against the ceiling' :
                 m && m.atFloor ? '   on the floor' : ''));

    if (m && oct !== null && !m.atCeiling && !m.atFloor) pts.push({ note: note, oct: oct });
  });

  if (pts.length >= 2) {
    var n2 = pts.length, sn = 0, sy = 0, snn = 0, sny = 0;
    pts.forEach(function (p) { sn += p.note; sy += p.oct; snn += p.note * p.note; sny += p.note * p.oct; });

    var perNote = (n2 * sny - sn * sy) / (n2 * snn - sn * sn);
    var intercept = (sy - perNote * sn) / n2;
    var pivot = perNote !== 0 ? -intercept / perNote : 0;

    var worst = 0;
    pts.forEach(function (p) {
      worst = Math.max(worst, Math.abs(p.oct - (perNote * p.note + intercept)));
    });

    console.log('');
    console.log('   ' + (perNote * 12).toFixed(3) + ' octaves of cutoff per octave of keyboard');
    console.log('   it adds nothing at note ' + pivot.toFixed(1) +
                '  -  the model assumes 60');
    console.log('   worst departure from that line: ' + worst.toFixed(3) + ' octaves');

    if (Math.abs(pivot - 60) > 1.5)
      console.log('   so a keygroup with tracking on reads ' +
                  ((60 - pivot) / 12 * perNote * 12).toFixed(2) +
                  ' octaves off at note 60, which is where the table point came from');

    result.tracking = { perOctave: perNote * 12, pivot: pivot };
  }
}

if (sections.opening && sections.opening.at.length)
  depth('opening', sections.opening.at, plan.OPEN_FROM,
        'OPENING  -  a positive amount, from the bottom of the travel');

if (sections.closing && sections.closing.at.length)
  depth('closing', sections.closing.at, plan.CLOSE_FROM,
        'CLOSING  -  the same amounts negative, from near the top');

// ------------------------------------------------------------- 3. is it symmetric?
if (result.opening && result.closing) {
  console.log('');
  console.log('SYMMETRY  -  does a negative amount go as far as a positive one?');

  var up = result.opening.envOctaves, down = result.closing.envOctaves;
  var ratio = down / up;

  console.log('   opening ' + up.toFixed(2) + ' octaves at full amount');
  console.log('   closing ' + down.toFixed(2) + ' octaves at full amount');
  console.log('   the closing side is ' + ratio.toFixed(3) + ' of the opening one');
  console.log('');
  console.log(Math.abs(ratio - 1) < 0.05
    ? '   symmetric to within 5% - the model assuming one number for both is right'
    : '   NOT symmetric - the model uses one number for both and should not');

  result.symmetry = ratio;
}

// ------------------------------------------------------------- 4. the release
if (sections.release && sections.release.at.length) {
  console.log('');
  console.log('RELEASE  -  how long the filter takes to fall back after the key comes up');

  var openHz = Audio.cutoffHz(plan.RELEASE_FROM, smp.sampleRate);

  sections.release.at.forEach(function (i) {
    var c = wanted[i];
    console.log('');
    console.log('   ' + c.label + '   model says ' +
                (Audio.envSeconds(c.setting) * Audio.CAL.VCF_TIME_SCALE).toFixed(3) + 's');

    /*
     * NOT by tracing the corner. By asking when the cutoff passed a few fixed frequencies.
     *
     * Finding a -3 dB corner needs the passband levelled, and the passband reference has to
     * sit well below the corner - down at 80 to 150 Hz for this filter. Following a release
     * needs windows of about a twelfth of a second, and over 3500 samples the spectrum down
     * there is worthless: the analysis resolves 43 Hz while those bands are 2 Hz apart, so
     * six noisy estimates get averaged into a reference that is anybody's guess. Traced that
     * way, a sweep from 9 kHz to 2 kHz read 169, 580, 137, 282 Hz - pure noise.
     *
     * A single frequency well up in the band has ninety cycles in the same window and is
     * measured solidly. So each probe is watched until the response there drops 3 dB, which
     * is the moment the cutoff swept past it, and the envelope's own shape turns that one
     * time into the release. Several probes at different heights give several independent
     * answers, and their agreement is a check on the shape rather than an assumption of it.
     */
    var loud = rms (during (i, 0.3, c.hold - 0.1));
    var win = 0.08, hop = win / 2;

    var startHz = corner(during(i, 0.3, c.hold - 0.1));
    var restHz = Audio.cutoffHz(plan.RELEASE_FROM, smp.sampleRate);

    if (startHz === null) { console.log('      could not read the cutoff while it was held'); return; }

    // probes between where the sweep starts and where it ends, clear of both
    var probes = [];
    [0.78, 0.6, 0.45, 0.33].forEach(function (f) {
      var hz = startHz * f;
      if (hz > restHz * 1.3) probes.push(hz);
    });

    var trace = [];
    for (var t = 0; t < 1.5; t += hop) {
      var span = during(i, c.hold + t, c.hold + t + win);
      if (span === null || rms (span) < loud * 0.02) break;      // 34 dB down: too quiet

      var spec = cal.spectrum(span, w.rate, probes);
      var ref = cal.spectrum(span, w.rate, [startHz * 0.06]);    // a long way below the sweep

      trace.push({
        t: t + win / 2,
        db: probes.map(function (hz, k) {
          return (spec[k].db - srcAt(hz)) - (ref[0].db - srcAt(startHz * 0.06));
        })
      });
    }

    if (trace.length < 2) { console.log('      the note was gone too soon to follow'); return; }

    console.log('      swept from ' + startHz.toFixed(0) + ' Hz down towards ' +
                restHz.toFixed(0) + ', watched at ' +
                probes.map(function (p) { return p.toFixed(0); }).join(', ') + ' Hz');

    /*
     * When the cutoff passed each probe, and what that says the release was.
     *
     * The envelope falls in a straight line in octaves, so the cutoff reaches a probe after
     * the fraction of the release given by how far down the probe sits. One crossing is one
     * estimate of the whole release; four of them agreeing is the shape being right.
     */
    var estimates = [];

    probes.forEach(function (hz, k) {
      var crossed = null;
      for (var n = 1; n < trace.length; n++) {
        if (trace[n].db[k] <= -3 && trace[n - 1].db[k] > -3) {
          var a2 = trace[n - 1].db[k] + 3, b2 = trace[n].db[k] + 3;
          var f = a2 / (a2 - b2);
          crossed = trace[n - 1].t + f * (trace[n].t - trace[n - 1].t);
          break;
        }
      }

      if (crossed === null) {
        console.log('        ' + hz.toFixed(0).padStart(5) + ' Hz   never crossed');
        return;
      }

      var fraction = Math.log2(startHz / hz) / Math.log2(startHz / restHz);
      var seconds = crossed / fraction;

      console.log('        ' + hz.toFixed(0).padStart(5) + ' Hz   passed at ' +
                  crossed.toFixed(3) + 's   so the release is ' + seconds.toFixed(3) + 's');
      estimates.push(seconds);
    });

    if (!estimates.length) {
      console.log('      nothing crossed - it was already shut when the first window opened, ' +
                  'which is what a release of ' + c.setting + ' should look like');
      return;
    }

    estimates.sort(function (a, b) { return a - b; });
    var measured = estimates[Math.floor(estimates.length / 2)];
    var spread = estimates[estimates.length - 1] / estimates[0];
    var says = Audio.envSeconds(c.setting) * Audio.CAL.VCF_TIME_SCALE;

    console.log('      release ' + measured.toFixed(3) + 's,  the model says ' +
                says.toFixed(3) + 's   ' + (measured / says).toFixed(2) + 'x' +
                (estimates.length > 1 ? '   (probes agree to ' + spread.toFixed(2) + 'x)' : ''));

    /*
     * And say so when they do not.
     *
     * Four probes on one sweep are four readings of the same number, so their spread is the
     * measurement's own error bar. Rendering a run whose release times are known exactly
     * still gave spreads of three to one, which means this method is not yet measuring the
     * release - it is measuring something correlated with it. Printing the median anyway
     * without saying that is how a guess becomes a constant.
     */
    if (spread > 1.5)
      console.log('      NOT a measurement: the probes should all give the same number and ' +
                  'they differ by ' + spread.toFixed(1) + 'x. Treat the clips as recorded ' +
                  'data for a better method, not as an answer.');

    (result.release || (result.release = [])).push({
      stored: c.setting, seconds: measured, spread: spread
    });
  });
}

console.log('');
