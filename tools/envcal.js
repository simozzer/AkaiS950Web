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

/*
 * --json out.json writes everything measured, as measured.
 *
 * A constant that gets into the engines by being read off a printed table and typed into a
 * header is a constant with a transcription in front of it. The numbers that matter here are
 * fitted against the rendered run to cancel the analysis's own bias, which is arithmetic
 * across two takes - exactly the kind that should be done by machine.
 */
var jsonOut = null;
for (var aj = 0; aj < args.length; aj++) {
  if (args[aj] === '--json') { jsonOut = args[aj + 1]; args.splice(aj, 2); break; }
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

/*
 * The sample every measurement divides by.
 *
 * It was always called NOISE, and insisting on that name was right while every run put one
 * piece of white noise on the disk. Run 6 needs two samples that can be told apart, so it
 * carries a SOFT sine and a HARD noise and there is no NOISE at all - and this refused to
 * open the disk rather than saying so.
 *
 * Whichever noise the plan declares will do: the divisor only has to be something with
 * energy at every frequency, and the corner measurements are the only things that use it.
 * A run that measures which sample sounded does not divide by anything.
 */
function sampleNamed(want) {
  var found = null;
  disk.entries.forEach(function (e) {
    if (e.type === 'S' && e.name.trim().toUpperCase() === want.toUpperCase()) found = e;
  });
  return found;
}

var smp = sampleNamed('NOISE');

if (!smp && plan.SAMPLES)
  plan.SAMPLES.forEach(function (s) { if (!smp && s.kind !== 'tone') smp = sampleNamed(s.name); });

if (!smp) disk.entries.forEach(function (e) { if (!smp && e.type === 'S') smp = e; });

if (!smp) { console.log('no sample at all in ' + image); process.exit(1); }

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
 * A note inside a run of sound that the splitter could not cut up is still a note.
 *
 * align() gives each found clip to one planned note, which is right when the splitter has
 * found the notes. It has not always: a long amplitude release leaves the gap quiet rather
 * than silent, and three release notes plus the clip after them came back as one continuous
 * 42-second stretch. Those three were then dropped for having no clip of their own, on a take
 * where every one of them is perfectly audible - the measurements read from the plan's
 * timeline, not from the clip edges, so the split never mattered to them in the first place.
 *
 * So after the offset is settled, anything still unplaced is looked for inside the clips:
 * if the whole note lies within a found stretch that is longer than the note itself, it is
 * there. This runs second and does not score, because letting containment count towards the
 * alignment would reward an offset that swallows the run in one clip.
 */
var rescued = 0;
wanted.forEach(function (c, i) {
  if (slot[i] >= 0) return;

  /*
   * Overlap rather than containment: the splitter trims the ends as well as merging the
   * middles. The stretch that swallowed the release section stopped five seconds before the
   * fourteen-second note at the end of it did, so asking for the whole note to be inside
   * still threw that one away. Two thirds of it inside a run of sound is enough to say the
   * note is in there.
   */
  var a = c.from + placed.offset, b = a + c.hold;
  for (var j = 0; j < found.clips.length; j++) {
    var s = found.clips[j].seconds;
    if (s[1] - s[0] <= c.hold * 1.2) continue;           // not a merge, just a clip
    var over = Math.min(b, s[1]) - Math.max(a, s[0]);
    if (over >= c.hold * 0.6) { slot[i] = j; rescued++; break; }
  }
});

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
  /*
   * Look back most of a gap, not a second.
   *
   * The splitter trims about a second and a half off the front of every note - it reports a
   * settled run of sound rather than an edge - so a window of a second either side of its
   * answer can lie entirely INSIDE the note. There is then no silence in it to measure an
   * onset against: the twentieth percentile is the note itself, the bar sits above
   * everything, and the search either fails or returns the loudest moment somewhere in the
   * middle. The whole take is then read a second and a half late, which is longer than most
   * of what this run is trying to measure - attack 70 and attack 80 both came back as flat
   * lines at the top of their travel, identical to the digit, because each was over before
   * the trace began.
   *
   * The gap is silent by construction and no note reaches across it, so looking back most of
   * one guarantees the window contains the silence this needs.
   */
  /*
   * And not so far FORWARD that the window reaches the next note.
   *
   * The look-ahead was a flat second, which is right when notes are fourteen seconds apart
   * and wrong when they are one: run 6 puts 0.6 s notes in 0.6 s gaps, so a second of
   * look-ahead from one note's position lands inside the next. The take aligned 0.94 s early
   * - a whole note out - because the search kept finding the following onset.
   *
   * Only the FORWARD side is bounded. Looking back has to stay generous, because that is the
   * fix described above for the splitter reporting a note well after it started - capping it
   * at a second as well undid it, and run 5 went from placing 21 clips of 21 to placing 20.
   */
  var back  = Math.max(0.15, plan.TIMING.gap * 0.8);
  var ahead = Math.min(1.0, Math.max(0.15, (plan.TIMING.hold || 1.0) * 0.8));
  var frame = Math.max(64, Math.round(w.rate * 0.01));
  var from = Math.max(0, Math.round((when - back) * w.rate));
  var to = Math.min(w.samples.length, Math.round((when + ahead) * w.rate));

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

/*
 * Each clip keeps its OWN onset, and the median is only the fallback.
 *
 * One offset for the whole take was right while every run played notes of the same shape:
 * whatever the detector was doing, it did it equally everywhere, and the median smoothed out
 * the scatter. Run 7 mixes an instant strike with a 1.4-second ramp, and those are not found
 * at the same moment - the splitter puts the ramped ones 1.20 s after the plan and the
 * instant ones 0.32 s after it. A single median then sits between the two and is wrong for
 * both, by nearly a second on clips whose whole measurement is worth 1.4.
 *
 * It matters most for a release, where the trace is timed from the key coming UP: that is the
 * note's own start plus its hold, so an onset out by a second reads a second of the wrong
 * thing. An attack shrugs it off, because the ramp is fitted with its start as a free
 * parameter and finds it whatever the window did.
 */
var offsets = [];
var startedEach = [];

wanted.forEach(function (c, i) {
  startedEach[i] = null;
  if (slot[i] < 0) return;

  var on = onsetNear(c.from + placed.offset);
  if (on === null) return;

  offsets.push(on - c.from);
  startedEach[i] = on - c.from;
});

offsets.sort(function (a, b) { return a - b; });
var startedAt = offsets.length ? offsets[Math.floor(offsets.length / 2)] : placed.offset;

/// Where clip `i` really began, from the audio where that could be read and the take's own
/// median where it could not.
function startOf(i) {
  return startedEach[i] === null ? startedAt : startedEach[i];
}

console.log('');
console.log('take: ' + (w.samples.length / w.rate).toFixed(1) + 's at ' + w.rate + ' Hz, ' +
            (placed.score + rescued) + ' of ' + wanted.length + ' clips' +
            (rescued ? ' (' + rescued + ' of them inside a stretch the splitter could not cut)' : '') +
            ', peak ' +
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

/*
 * `referenceTop` raises that ceiling for callers that know their corner stays well above it.
 *
 * 150 Hz is only 22 bands, and 22 bands is not enough to average over a quarter-second
 * window: the levelling then carries a few dB of scatter, and a few dB is more than the 3
 * this is looking for, so the crossing is found immediately and the corner comes back at a
 * couple of hundred hertz on a clip sitting at nine thousand. Measured on rendered audio at
 * a known 2210 Hz, six windows each:
 *
 *              ref<150   ref<400
 *     0.20s      1/6       3/6
 *     0.25s      3/6       5/6
 *     0.30s      4/6       6/6
 *
 * Below a quarter of a second nothing saves it, and above 400 Hz there is little more to
 * gain - but between those, a wider reference is the difference between a trace and noise.
 * The trajectory section picks its own ceiling from a coarse first pass; everything else
 * keeps 150, because the floor clips really do close to 311 Hz and a 400 Hz reference would
 * be sitting on the roll-off it is trying to measure.
 */
/*
 * The source's spectrum over the same stretch of the loop the window is looking at.
 *
 * Dividing by the sample's own spectrum is what makes every measurement here independent of
 * what the noise happens to be - but the whole sample's spectrum is only the right divisor
 * for a window that covers the whole sample. Over a quarter of a second it is the wrong one:
 * three seconds of noise is flat on average and emphatically not flat in any given quarter
 * second, so a window landing on a stretch that dips reads that dip as the filter's.
 *
 * It is not scatter, either - it repeats. The sample loops every three seconds, so the same
 * unlucky stretch comes round again and misreads again, identically. Release 70 traced 1845
 * Hz at 3.63s and 1845 Hz at 6.63s on a note steady at 2305, and a median filter cannot tell
 * that from a real measurement because it happens for several windows together.
 *
 * Constant pitch is set on every keygroup in the run, so the sample plays at its own rate
 * whatever key it is on, and the source offset is simply the time since the note began. On
 * the same steady 2305 Hz corner, across two turns of the loop:
 *
 *     whole-sample divisor    168 .. 2356 Hz
 *     position-matched       2291 .. 2303 Hz
 *
 * The long-window analyses keep the whole-sample divisor: they average over several turns of
 * the loop, which is the case it was always right for.
 */
var srcSpecCache = {};

function srcSpecFor(seconds, lengthSeconds) {
  var n = Math.round(lengthSeconds * smp.sampleRate);
  if (n < 2048) return srcSpec;

  var at = Math.round(seconds * smp.sampleRate);
  if (!plan.LOOPING && at + n > source.length) return srcSpec;
  at = ((at % source.length) + source.length) % source.length;

  var key = at + ':' + n;
  if (srcSpecCache[key]) return srcSpecCache[key];

  var piece = new Float64Array(n);
  for (var i = 0; i < n; i++) piece[i] = source[(at + i) % source.length];

  return (srcSpecCache[key] = cal.spectrum(piece, smp.sampleRate, cal.BANDS));
}

function corner(samples, referenceTop, against) {
  if (!samples || samples.length < 2048) return null;
  var top  = referenceTop || REFERENCE_TOP;
  var ss   = against || srcSpec;
  var spec = cal.spectrum(samples, w.rate, cal.BANDS);

  var ref = 0, n = 0;
  for (var j = 0; j < cal.BANDS.length; j++)
    if (cal.BANDS[j] < top) { ref += spec[j].db - ss[j].db; n++; }
  if (n < 3) { ref = 0; for (var j2 = 0; j2 < 3; j2++) ref += spec[j2].db - ss[j2].db; n = 3; }
  ref /= n;

  for (var k = 1; k < cal.BANDS.length; k++) {
    var a = (spec[k - 1].db - ss[k - 1].db) - ref;
    var b = (spec[k].db - ss[k].db) - ref;
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

/*
 * The power at ONE frequency, with nothing smoothed into it.
 *
 * cal.spectrum averages every band with its two neighbours either side, which is right for
 * the dense log ladder it was built for - those bands are a couple of hertz apart and the
 * response across them really is smooth - and wrong for a handful of probes spanning an
 * octave and a half. Handed seven of those it smears each one with frequencies far away,
 * and the sweep passing a probe stops being visible at all: crossings came out scattered
 * and not even in order.
 *
 * So the probes get their own measurement. Hann windows, Goertzel at the one frequency,
 * averaged across the windows the way spectrum does - just without the smoothing.
 */
/*
 * A NARROW BAND, not a single frequency.
 *
 * The power of noise in one bin scatters by about its own size: over a twelfth of a second
 * only two windows can be averaged, which leaves several dB of scatter on a measurement
 * whose threshold is three. Crossings then land wherever the noise put them, and came out
 * neither monotone nor in the right decade.
 *
 * So each probe is nine frequencies spread across a twentieth either side, averaged. The
 * filter's response is flat to a hundredth of a dB over a span that narrow, and the nine
 * estimates are independent, so the scatter drops by three. The time resolution is untouched,
 * which is the point - widening the window instead would have cost exactly what this is
 * trying to measure.
 */
var SUB_PROBES = 9, SUB_SPREAD = 0.05;

function powerAt(x, hz) {
  if (!x || x.length < 512) return 0;

  var win = Math.min(2048, 1 << Math.floor(Math.log2(x.length)));
  var hop = Math.max(1, Math.floor(win / 2));

  var window = new Float64Array(win);
  for (var i = 0; i < win; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (win - 1));

  var total = 0, n = 0;

  for (var p = 0; p < SUB_PROBES; p++) {
    var f = hz * (1 + SUB_SPREAD * (2 * p / (SUB_PROBES - 1) - 1));
    var c = 2 * Math.cos(2 * Math.PI * f / w.rate);

    for (var at = 0; at + win <= x.length; at += hop) {
      var s1 = 0, s2 = 0;
      for (var j = 0; j < win; j++) {
        var s = x[at + j] * window[j] + c * s1 - s2;
        s2 = s1; s1 = s;
      }
      total += Math.max(s1 * s1 + s2 * s2 - c * s1 * s2, 0);
      n++;
    }
  }
  return n ? total / n / win : 0;
}

/** The same, in decibels and with the source's own level at that frequency divided out. */
function levelAt(x, hz) {
  var p = powerAt(x, hz);
  return (p > 0 ? 10 * Math.log10(p) : -300) - srcAt(hz);
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
  var begins = wanted[i].from + startOf(i);
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

/*
 * The SHAPE of a sweep, without needing to know where it started or where it ends.
 *
 * If the cutoff moves in a straight line in octaves, then the moment it passes any frequency
 * is a straight-line function of the logarithm of that frequency. So watch a handful of fixed
 * probes, note when the response at each drops 3 dB, and fit time against log frequency: a
 * straight line means linear in octaves, and the residual says how straight.
 *
 * Neither end of the sweep comes into it, which is the point. Both are hard to measure while
 * the thing is moving, and both are where the earlier attempts came unstuck - run 1 and run 2
 * disagreed by two and a half times for the same setting precisely because each converted a
 * crossing into a time by ASSUMING this shape.
 */
if (sections.shape && sections.shape.at.length) {
  console.log('');
  console.log('SHAPE  -  is the sweep a straight line in octaves?');

  result.shape = [];

  sections.shape.at.forEach(function (i) {
    var c = wanted[i];
    var probes = c.probes;
    if (!probes || !probes.length) return;

    console.log('');
    console.log('   ' + c.section + ' / ' + c.label);

    // a note that is let go is measured from the release; one that is held, from the strike
    var begins = c.hold < plan.TIMING.hold ? c.hold : 0.0;
    var loud = rms (during (i, begins + 0.05, begins + 0.35));

    var win = 0.08, hop = win / 2;
    var reference = probes[0] * 0.08;              // well below the sweep, still in the pass
    var trace = [];

    for (var t = 0; t < 2.6; t += hop) {
      var span = during(i, begins + t, begins + t + win);
      if (span === null || rms (span) < loud * 0.02) break;

      var base = levelAt (span, reference);      // the passband, to measure the probes against

      trace.push({
        t: t + win / 2,
        db: probes.map(function (hz) { return levelAt (span, hz) - base; })
      });
    }

    if (trace.length < 3) { console.log('      the note was gone too soon to follow'); return; }

    /*
     * When each probe was passed, searched from the STOPBAND end.
     *
     * Taking the first dip below -3 dB finds noise rather than the sweep. A probe sitting in
     * the passband reads about zero with a decibel or so of scatter, and over sixty windows
     * and seven probes something will dip three decibels by chance - so first-crossing put
     * 2700 Hz at 0.34 s when the sweep did not reach it until 2.05.
     *
     * The far side has no such problem. Once the sweep has gone past, the probe is twenty or
     * thirty decibels down, and no amount of scatter brings it back over the threshold. So
     * for a falling sweep the crossing is searched backwards from the end, and for a rising
     * one - which starts in the stopband instead - forwards from the beginning.
     */
    var crossings = [];
    probes.forEach(function (hz, k) {
      var found = null;

      if (c.rising) {
        for (var n = 1; n < trace.length && found === null; n++)
          if (trace[n].db[k] >= -3 && trace[n - 1].db[k] < -3) found = n;
      } else {
        for (var m = trace.length - 1; m >= 1 && found === null; m--)
          if (trace[m].db[k] <= -3 && trace[m - 1].db[k] > -3) found = m;
      }

      if (found === null) return;

      var before = trace[found - 1].db[k], now = trace[found].db[k];
      var f = (before + 3) / (before - now);
      crossings.push({ hz: hz,
                       t: trace[found - 1].t + f * (trace[found].t - trace[found - 1].t) });
    });

    crossings.sort(function (a, b) { return a.t - b.t; });

    if (crossings.length < 4) {
      console.log('      only ' + crossings.length + ' of ' + probes.length +
                  ' probes were crossed - the sweep did not span them');
      return;
    }

    // fit time against log2(frequency); straight means linear in octaves
    var n2 = crossings.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    crossings.forEach(function (p) {
      var x = Math.log2(p.hz);
      sx += x; sy += p.t; sxx += x * x; sxy += x * p.t;
    });
    var slope = (n2 * sxy - sx * sy) / (n2 * sxx - sx * sx);
    var intercept = (sy - slope * sx) / n2;

    var worst = 0, span = 0;
    crossings.forEach(function (p) {
      worst = Math.max(worst, Math.abs(p.t - (slope * Math.log2(p.hz) + intercept)));
    });
    span = crossings[crossings.length - 1].t - crossings[0].t;

    crossings.forEach(function (p) {
      console.log('      ' + p.hz.toFixed(0).padStart(6) + ' Hz  passed at ' +
                  p.t.toFixed(3) + 's   line says ' +
                  (slope * Math.log2(p.hz) + intercept).toFixed(3) + 's');
    });

    /*
     * Straight or not, judged by the rate at each END rather than by the scatter.
     *
     * "How far is the worst point from the line" answers the wrong question: it is dominated
     * by the measurement's own noise, which on a sweep the model makes perfectly straight
     * still comes to a tenth of the span. Set a threshold below that and everything reads
     * curved; set it above and nothing ever will.
     *
     * Curvature has a direction, and noise does not. So the crossings are split in half and
     * each half given its own rate: a straight line gives the same rate twice, and a fall
     * that decelerates - which is what an exponential envelope would do - gives a slower
     * second half. The ratio says both whether it bends and which way.
     */
    var half = Math.floor(crossings.length / 2);
    var firstOct = Math.abs(Math.log2(crossings[0].hz / crossings[half].hz));
    var lastOct = Math.abs(Math.log2(crossings[half].hz / crossings[crossings.length - 1].hz));
    var firstSec = crossings[half].t - crossings[0].t;
    var lastSec = crossings[crossings.length - 1].t - crossings[half].t;

    var early = firstSec > 0 ? firstOct / firstSec : 0;
    var late = lastSec > 0 ? lastOct / lastSec : 0;
    var bend = early > 0 ? late / early : 1;

    var crooked = span > 0 ? worst / span : 0;
    console.log('      ' + Math.abs(1 / slope).toFixed(2) + ' octaves per second overall' +
                '   scatter ' + (crooked * 100).toFixed(0) + '% of the sweep');
    console.log('      first half ' + early.toFixed(2) + ' oct/s,  second half ' +
                late.toFixed(2) + '  -  ' + bend.toFixed(2) + 'x');

    /*
     * Which SHAPE the crossings prefer, rather than how bent they look.
     *
     * Splitting them in half and comparing rates asks nine points for a second derivative,
     * and the answer is swamped: on a sweep the model makes perfectly straight it came back
     * anywhere from 0.42x to 2.01x. The crossings do carry the shape - that statistic just
     * throws most of them away.
     *
     * So both candidates are fitted to all of the crossings and their residuals compared.
     *
     *   a straight ramp    the octaves fallen go as (1 - t/T), so t is a straight line
     *                      against log2(f) - which is the fit already done above
     *
     *   an exponential     the octaves fallen go as exp(-t/tau), so t is a straight line
     *                      against log(octaves fallen) instead
     *
     * The second needs to know where the sweep began, which is exactly what is hard to
     * measure - so it is searched for rather than assumed, and the exponential gets its best
     * possible start. Giving the rival model every advantage is the point: if the straight
     * line still fits better, that means something.
     */
    var straight = worst;
    var curved = Infinity, curvedStart = 0;

    /*
     * The search for where the sweep began is kept to what is physically possible.
     *
     * Left free it runs away: for a sweep starting at 8790 Hz it picked 24869, because a
     * start far above the probes makes the exponential degenerate into the straight line and
     * then fit the noise slightly better with its extra parameter. That is overfitting, not
     * evidence, and it chose the exponential for seven of eleven sweeps the model had drawn
     * as straight ramps.
     *
     * The plan puts every probe within a third of an octave of the sweep's ends, so the start
     * is between 1.1 and 1.8 times the highest probe. And the exponential has to win by a
     * clear margin rather than a hair, since it will always fit at least as well.
     */
    for (var s = 1.1; s <= 1.8; s *= 1.03) {
      var start = crossings[0].hz * s;
      var xs = [], ok = true;

      crossings.forEach(function (p) {
        var oct = Math.log2(start / p.hz);
        if (oct <= 1e-6) { ok = false; return; }
        xs.push(Math.log(oct));
      });
      if (!ok || xs.length !== crossings.length) continue;

      var n3 = xs.length, ax = 0, ay = 0, axx = 0, axy = 0;
      xs.forEach(function (x, k) {
        ax += x; ay += crossings[k].t; axx += x * x; axy += x * crossings[k].t;
      });
      var b3 = (n3 * axy - ax * ay) / (n3 * axx - ax * ax);
      var a3 = (ay - b3 * ax) / n3;

      var w3 = 0;
      xs.forEach(function (x, k) { w3 = Math.max(w3, Math.abs(crossings[k].t - (a3 * 1 + b3 * x))); });
      if (w3 < curved) { curved = w3; curvedStart = start; }
    }

    console.log('      the straight ramp misses by ' + straight.toFixed(3) +
                's at worst; the best exponential by ' + curved.toFixed(3) + 's');
    console.log(curved < straight * 0.7
      ? '      the crossings prefer an EXPONENTIAL, best fitted from ' +
        curvedStart.toFixed(0) + ' Hz'
      : '      nothing here beats a STRAIGHT RAMP');

    /*
     * The threshold is set by what this method does to a sweep that is known to be straight.
     *
     * Rendered through the model - whose envelope is a straight ramp by construction - the
     * same statistic came back anywhere from 0.42x to 2.01x across eleven clips. That is the
     * noise floor, and it is large: the crossings carry about a tenth of a second of scatter
     * each, and asking a handful of them for a second derivative is asking a lot.
     *
     * So this catches a gross departure and nothing finer. An exponential fall would show as
     * a second half several times slower, which is well outside that band; a mild bend would
     * not show at all. Anything inside the band is reported as "no bend this can see",
     * which is not the same as straight and should not be written down as though it were.
     */
    console.log(bend > 0.4 && bend < 2.1
      ? '      no bend this method can see - the noise floor here is 0.4x to 2.1x'
      : bend <= 0.4
        ? '      DECELERATING, and well past the noise - not a straight ramp'
        : '      ACCELERATING, and well past the noise - nothing in the model does that');

    result.shape.push({ label: c.label, section: c.section,
                        octavesPerSecond: Math.abs(1 / slope), bend: bend });
  });
}

/*
 * The whole trajectory of a slow sweep, measured rather than inferred.
 *
 * This is what the looping sample bought. A three-second note forced every envelope to be
 * fast, a fast sweep can only be followed in short windows, and a short window cannot find a
 * corner - so the first three runs had to work from threshold crossings carrying a tenth of a
 * second of scatter each, and the shape never came out of them.
 *
 * With fourteen seconds a decay of 95 takes nine of them, and a half-second window smears the
 * sweep by a tenth of an octave while measuring the corner to a hundredth. So the corner is
 * simply measured, twenty times down the sweep, and the shape read off the result.
 */
if (sections.trajectory && sections.trajectory.at.length) {
  console.log('');
  console.log('TRAJECTORY  -  the cutoff measured all the way along');

  result.trajectory = [];

  sections.trajectory.at.forEach(function (i) {
    var c = wanted[i];
    console.log('');
    console.log('   ' + c.section + ' / ' + c.label);

    // a released note is watched from the key coming up; a held one from the strike
    var begins = c.section === 'release' ? c.hold : 0.0;
    var span = c.section === 'release' ? plan.TIMING.gap * 0.9 : c.hold - 0.3;

    /*
     * The window follows the note rather than being fixed at half a second.
     *
     * Half a second is right for a decay of 95, which takes nine of them, and useless for an
     * attack of 50, which is over in a seventh of one. The attacks in this run span a factor
     * of forty in time, so the window is cut to a fortieth of the stretch being watched and
     * floored at an eighth of a second, below which a corner stops being measurable at all:
     * the reference bands this levels against are under 150 Hz, and an eighth of a second is
     * eighteen cycles of the lowest of them.
     *
     * A fortieth rather than a twentieth because the plan floors its short holds at six
     * seconds - there is nothing to watch once a fast rise has finished, but the hold cannot
     * shrink below what the settled reading needs - so a span sized for the settling is
     * several times longer than the sweep inside it. At a twentieth, attack 50 got one point
     * on its rise and attack 55 got one as well, and the two came back with the same trace.
     */
    var win = Math.max(0.25, Math.min(0.5, span / 40));
    var hop = win / 2;
    var loud = rms (during (i, begins + 0.1, begins + 0.6));

    /*
     * A coarse pass first, to find out how low this clip goes.
     *
     * The fine trace needs a reference well below its own corner and as wide as it can
     * safely be, and only the clip itself can say where "safely" is. Half-second windows are
     * reliable with the fixed 150 Hz reference, so they are used to find the bottom of the
     * sweep; the twentieth percentile rather than the minimum, because the few readings that
     * do fail at this width all fail LOW and the minimum would be one of them.
     *
     * A quarter of the answer leaves two octaves of clearance, which every clip in this
     * section has: they all sweep from a base of stored 50, and nothing here is asked to
     * close below it.
     */
    var rough = [];
    for (var ct = 0; ct + 0.5 < span; ct += 0.5) {
      var cAudio = during(i, begins + ct, begins + ct + 0.5);
      if (cAudio === null || rms (cAudio) < loud * 0.3) break;
      var cHz = corner(cAudio, REFERENCE_TOP, srcSpecFor(begins + ct, 0.5));
      if (cHz) rough.push(cHz);
    }
    rough.sort(function (a, b) { return a - b; });

    var refTop = rough.length
      ? Math.max(REFERENCE_TOP, Math.min(1100, rough[Math.floor(rough.length * 0.2)] / 4))
      : REFERENCE_TOP;

    var trace = [];

    for (var t = 0; t + win < span; t += hop) {
      var audio = during(i, begins + t, begins + t + win);
      if (audio === null) break;

      /*
       * A window the note has stopped under measures the room, not the filter.
       *
       * Every held clip here sustains at full, so its level is flat until the key comes up:
       * a window whose level has collapsed is one that has run off the end of the note, and
       * the corner read from it is whatever the noise floor happens to do. One came back at
       * 332 Hz on a clip that never went below 8800, and that single point at the end of the
       * trace doubled the reported travel and with it every shape fitted to it. A releasing
       * clip is meant to fade, so there the old and much lower bar still stands.
       */
      if (rms (audio) < loud * (c.section === 'release' ? 0.02 : 0.5)) break;

      /*
       * A corner near its own reference is not a corner.
       *
       * The levelling assumes the reference bands are passband, so a reading that comes back
       * close to them contradicts the measurement that produced it - it is the scatter in the
       * reference being read as a roll-off. One such point at 318 Hz, on a clip that never
       * went below 2210, turned 1.2 octaves of travel into 4.8 and took every shape fitted to
       * it along. Half an octave of clearance is the least that means anything.
       */
      var hz = corner(audio, refTop, srcSpecFor(begins + t, win));
      if (hz === null || hz > CEILING * 1.05) continue;
      if (hz < Math.max(FLOOR * 0.9, refTop * 1.5)) continue;
      trace.push({ t: t + win / 2, hz: hz });
    }

    if (trace.length < 6) { console.log('      only ' + trace.length + ' points - too few'); return; }

    /*
     * A median of three across the trace, before anything is read off it.
     *
     * Each window measures its corner on its own, so one that lands on an unlucky stretch of
     * the noise misreads while both its neighbours are right: release 70 traced 2304, 2299,
     * 1845, 2304 - a quarter of an octave low, twice in sixteen points. Nothing downstream
     * survives that, because the travel is taken from the extremes and the arrival is
     * measured against them: those two points stretched a 1.2-octave release to 1.9 and moved
     * its finish from 1.1 seconds to 3.4, while the shape fitted to the same trace was
     * reporting the right answer all along.
     *
     * A median of three is the filter this wants rather than an average. The sweep is
     * monotone, so three consecutive points are already in order and the middle one comes
     * through untouched - no smearing of the thing being measured - while an isolated spike
     * is discarded by construction. The two ends keep their own value.
     */
    trace = trace.map(function (p, m) {
      if (m === 0 || m === trace.length - 1) return p;
      var three = [trace[m - 1].hz, p.hz, trace[m + 1].hz].sort(function (a, b) { return a - b; });
      return { t: p.t, hz: three[1] };
    });

    var all = trace.map(function (p) { return p.hz; });
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    var travel = Math.log2(hi / lo);

    if (travel < 0.5) {
      console.log('      it moved ' + travel.toFixed(2) + ' octaves - too little to read a shape from');
      return;
    }

    trace.forEach(function (p, n) {
      if (n % 3 && n !== trace.length - 1) return;
      console.log('      ' + p.t.toFixed(2).padStart(6) + 's  ' + p.hz.toFixed(0).padStart(6) + ' Hz');
    });

    /*
     * How far along it is, as a fraction of its own travel: 0 where it starts, 1 where it
     * ends. Then the two candidate shapes are fitted to that and their misses compared.
     *
     * Both get one free parameter - a time - so this is a fair comparison, unlike the
     * crossing version where the exponential had a free start frequency as well and won by
     * overfitting.
     */
    var moved = trace.map(function (p) {
      var f = (Math.log2(p.hz) - Math.log2(lo)) / travel;         // 0..1, low to high
      return { t: p.t, done: c.rising ? f : 1 - f };              // 0 at the start, 1 at the end
    });

    function missBy(shape, param) {
      var worst = 0;
      moved.forEach(function (p) { worst = Math.max(worst, Math.abs(p.done - shape(p.t, param))); });
      return worst;
    }

    var last = moved[moved.length - 1].t;
    var bestRamp = { miss: Infinity, T: 0 }, bestExp = { miss: Infinity, tau: 0 };

    for (var k = 0.05; k <= 3.0; k *= 1.03) {
      var T = last * k;
      var mr = missBy(function (t, p) { return Math.min(1, t / p); }, T);
      if (mr < bestRamp.miss) bestRamp = { miss: mr, T: T };

      var me = missBy(function (t, p) { return 1 - Math.exp(-t / p); }, T);
      if (me < bestExp.miss) bestExp = { miss: me, tau: T };
    }

    console.log('      it travelled ' + travel.toFixed(2) + ' octaves over ' +
                last.toFixed(1) + 's');

    /*
     * When it got there - the one number the attack section exists for.
     *
     * Read off the trace rather than fitted, so a sweep that is neither of the two candidate
     * shapes still gives an answer: the first window whose corner is within a twentieth of an
     * octave of the far end of the travel. A window averages the sweep passing through it, so
     * this runs about half a window late; at the fast end that is most of what it reports,
     * which is why the settled corner is worth more there than the shape is.
     */
    var target = c.rising ? hi : lo;
    var arrived = null;
    for (var q = 0; q < trace.length; q++)
      if (Math.abs(Math.log2(trace[q].hz / target)) < 0.05) { arrived = trace[q].t; break; }

    console.log(arrived === null
      ? '      it had not settled by the end of the note'
      : '      it was within a twentieth of an octave of the end by ' + arrived.toFixed(2) +
        's  (windows of ' + win.toFixed(2) + 's, so about half of one late)');
    console.log('      a straight ramp misses by ' + bestRamp.miss.toFixed(3) +
                ' (over ' + bestRamp.T.toFixed(2) + 's);  an exponential by ' +
                bestExp.miss.toFixed(3) + ' (time constant ' + bestExp.tau.toFixed(2) + 's)');

    var verdict = bestRamp.miss < bestExp.miss * 0.7 ? 'a STRAIGHT RAMP'
                : bestExp.miss < bestRamp.miss * 0.7 ? 'an EXPONENTIAL'
                : 'neither clearly - they fit within 30% of each other';
    console.log('      the measurements prefer ' + verdict);

    result.trajectory.push({
      label: c.label, section: c.section, setting: c.setting, travel: travel,
      rampSeconds: bestRamp.T, tau: bestExp.tau, settledBy: arrived,
      prefers: verdict
    });
  });
}

/*
 * The settled corner where the envelope has finished, for the clips asking where the bottom
 * of the filter's travel really is.
 */
/*
 * WHICH SAMPLE ANSWERED - the velocity switch, measured.
 *
 * The keygroup holds a sine in zone 1 and noise in zone 2, so "which one is this" is answered
 * by how much of the clip's energy sits at the tone's own frequency. Nearly all of it, and it
 * is the sine; almost none, and it is the noise.
 *
 * Against the two samples themselves rather than against a threshold. Both are on the disk,
 * so the analysis reads each one, measures it the same way, and asks which of those two
 * numbers a clip is nearer in the log. That needs no constant anyone has to justify, and it
 * cannot drift if the recording chain rolls off or the levels differ.
 *
 * A CROSSFADE WOULD SHOW AS A MIDDLE READING
 *
 * If the machine blends the two zones over a few velocities rather than switching between
 * them, a clip in the blend is part sine and part noise and lands between the two references
 * instead of on one. That is reported rather than rounded to the nearer, because "there is a
 * blend here" is the more interesting of the two answers this run can give.
 */
if (sections.zone && sections.zone.at.length) {
  console.log('');
  console.log('THE VELOCITY SWITCH  -  which sample a strike reaches');

  var toneHz = plan.TONE_HZ || 1000;

  /// How much of a stretch of audio sits at the tone's frequency, against all of it.
  function toneShare(x) {
    if (!x || x.length < 512) return 0;

    // `win`, not `w` - the take is called w, and a Hann window shadowing it turns every
    // angle below into NaN without a word of complaint.
    var re = 0, im = 0, total = 0;
    for (var i = 0; i < x.length; i++) {
      var win = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (x.length - 1));
      var s = x[i] * win;
      var a = 2 * Math.PI * toneHz * i / w.rate;
      re += s * Math.cos(a);
      im += s * Math.sin(a);
      total += s * s;
    }

    var at = 2 * (re * re + im * im) / (x.length * x.length);
    return total > 0 ? at / (total / x.length) : 0;
  }

  // the two samples as they are on the disk, measured the same way
  function shareOfSample (name) {
    var e = sampleNamed (name);
    if (!e) return null;
    var ws = disk.sampleWords12 (e);
    var buf = new Float64Array (Math.min (ws.length, Math.round (0.4 * w.rate)));
    for (var i = 0; i < buf.length; i++) buf[i] = ws[i] / 2048;
    return toneShare (buf);
  }

  var refSoft = shareOfSample ((plan.SAMPLES && plan.SAMPLES[0].name) || 'SOFT');
  var refHard = shareOfSample ((plan.SAMPLES && plan.SAMPLES[1].name) || 'HARD');

  if (refSoft === null || refHard === null || !(refSoft > refHard)) {
    console.log('   cannot read the two samples off the disk to compare against');
  }
  else {
    console.log('   the samples themselves read ' + refSoft.toFixed(3) +
                ' (zone 1) and ' + refHard.toFixed(4) + ' (zone 2)');

    var bySection = {};
    sections.zone.at.forEach(function (i) {
      var c = wanted[i];
      (bySection[c.section] || (bySection[c.section] = [])).push(i);
    });

    result.zone = [];

    Object.keys(bySection).forEach(function (name) {
      console.log('');
      console.log('   ' + name);

      var last = null, boundary = null, blended = 0;

      bySection[name].forEach(function (i) {
        var c = wanted[i];

        // past the attack, before the key comes up - the steadiest part of a short note
        var audio = during(i, 0.1, c.hold - 0.1);
        if (audio === null) { console.log('      v' + c.velocity + '  no audio'); return; }

        var share = toneShare(audio);

        /*
         * Where it falls between the two, in the log, as 0 for the sine and 1 for the noise.
         * Anything between a tenth and nine tenths is neither sample on its own.
         */
        var t = (Math.log(share) - Math.log(refSoft)) /
                (Math.log(refHard) - Math.log(refSoft));
        var which = t < 0.1 ? 'zone 1' : t > 0.9 ? 'zone 2' : 'BLENDED';
        if (which === 'BLENDED') blended++;

        if (last !== null && last !== which && which === 'zone 2' && boundary === null)
          boundary = c.velocity;
        last = which;

        console.log('      velocity ' + String(c.velocity).padStart(3) + '   ' +
                    share.toFixed(4).padStart(8) + '   ' + which +
                    (which === 'BLENDED' ? '  (' + Math.round(t * 100) + '% of the way over)' : ''));

        result.zone.push({ section: name, velocity: c.velocity, share: share,
                           towards: t, which: which });
      });

      /*
       * The byte is the LAST velocity of zone 1, so zone 2 should first answer one above it.
       *
       * This compared against the byte itself and reported every correct reading as "out by
       * 1" - which is how run 6 found the error in the first place, and would now hide the
       * fix. A switch of 127 or 128 puts zone 2 out of reach of any playable velocity, and
       * seeing no handover there is the right answer rather than a failure to find one.
       */
      var says = wanted[bySection[name][0]].velocitySwitch;
      var expect = says + 1;

      if (blended)
        console.log('      ' + blended + ' clip(s) between the two samples - this is a ' +
                    'CROSSFADE, not a switch');
      else if (boundary === null)
        console.log('      no handover in this sweep' +
                    (expect > 127 ? '  - and the byte says there cannot be one'
                                  : '  - but the byte expects one at ' + expect));
      else
        console.log('      zone 2 first answers at velocity ' + boundary +
                    ', and the byte expects ' + expect +
                    (boundary === expect ? '  - the model is right'
                                         : '  - the model is out by ' + (boundary - expect)));
    });
  }
}

if (sections.settled && sections.settled.at.length) {
  console.log('');
  console.log('THE FLOOR  -  how far down the cutoff will actually go');
  console.log('   amount     corner      the model clamps at ' + FLOOR.toFixed(0) + ' Hz');

  sections.settled.at.forEach(function (i) {
    var m = steady(i);
    console.log('     ' + String(wanted[i].setting).padStart(4) + '   ' +
                (m ? m.hz.toFixed(0).padStart(6) + ' Hz' : '  not found'));
    if (m) (result.floor || (result.floor = [])).push({ amount: wanted[i].setting, hz: m.hz });
  });

  /*
   * Only the deepest two decide it.
   *
   * The section deliberately includes amounts that stop ABOVE the floor - they are what
   * measures the slope on the way down, and what says the clips are working at all. Asking
   * whether all four agree therefore always answers no: with -4 landing at 726 Hz by design,
   * the spread came out at 1.25 octaves and the verdict read "the clamp is in the wrong
   * place" off a set of clips that mostly never reached it.
   *
   * The two most negative amounts are the ones driven well past where the model stops, so
   * they are the ones whose agreement means something.
   */
  if (result.floor && result.floor.length >= 2) {
    var order = result.floor.slice().sort(function (a, b) { return a.amount - b.amount; });
    var deep  = order.slice(0, 2);
    var spread = Math.abs(Math.log2(deep[0].hz / deep[1].hz));
    var bottom = Math.min(deep[0].hz, deep[1].hz);

    console.log('');
    console.log('   the two deepest (' + deep[0].amount + ' and ' + deep[1].amount +
                ') are the ones driven past where the model stops');
    console.log(spread < 0.08
      ? '   they land in the same place, so there is a hard floor - and it is at ' +
        bottom.toFixed(0) + ' Hz' +
        (Math.abs(Math.log2(bottom / FLOOR)) < 0.08 ? ', where the model puts it'
                                                    : ', NOT the ' + FLOOR.toFixed(0) + ' the model uses')
      : '   they differ by ' + spread.toFixed(2) + ' octaves, so the cutoff is still moving ' +
        'down there and there is no hard floor to find');
  }
}

/*
 * The amplitude envelope, watched as a level rather than a corner.
 */
if (sections.level && sections.level.at.length) {
  console.log('');
  console.log('LEVEL  -  the amplitude envelope on a long note');

  sections.level.at.forEach(function (i) {
    var c = wanted[i];
    console.log('');
    console.log('   ' + c.label);

    /*
     * Short windows, because a level needs no spectrum.
     *
     * The corner analysis is stuck with quarter-second windows - it has to resolve bands
     * under 150 Hz - but an rms is just as good over a fortieth of a second, and the fastest
     * thing here may be under a tenth. At a quarter second an attack of 30 would have been
     * two points and an answer to one significant figure.
     */
    /*
     * A release clip is watched from the key coming UP, everything else from the strike.
     *
     * The amplitude release is the one stage that happens after the note is let go, so a
     * trace that stops at the hold - which is all this ever did - cannot see it at all. The
     * falling branch below is already the right measurement for it; it only had to be
     * pointed at the right stretch of audio.
     */
    var fromKeyUp = /^release/.test(c.section);
    var begins = fromKeyUp ? c.hold : 0.0;
    var until  = fromKeyUp ? plan.TIMING.gap * 0.9 : c.hold - 0.2;

    function traceAt(win) {
      var out = [], hop = win / 2;
      for (var t = 0; t + win < until; t += hop) {
        var audio = during(i, begins + t, begins + t + win);
        if (audio === null) break;
        out.push({ t: t + win / 2, db: 20 * Math.log10(Math.max(rms (audio), 1e-9)) });
      }
      return out;
    }

    /*
     * Sized to the ramp, in two passes, because a window is an average.
     *
     * The rms over a window that covers a quarter of the rise is not the level at the middle
     * of that window - it is pulled up towards the loud end, so the early points read as a
     * shorter ramp than they came from. On a rendered attack of 40, whose ramp really is
     * straight, the estimates spread 1.4x and the analysis called it not straight.
     *
     * A rough pass finds the length, then the real one uses a window a twenty-fifth of it, so
     * the averaging is worth well under a per cent wherever it is read. That keeps the spread
     * across the points meaning what it is quoted as meaning - whether the rise is a straight
     * ramp - rather than measuring the window against the ramp.
     */
    var trace = traceAt(0.04);

    if (c.rising && trace.length >= 6) {
      var rough = [], top = Math.max.apply(null, trace.map(function (p) { return p.db; }));
      trace.forEach(function (p) {
        var g = Math.pow(10, (p.db - top) / 20);
        if (g > 0.2 && g < 0.9 && p.t > 0) rough.push(p.t / g);
      });
      if (rough.length) {
        rough.sort(function (x, y) { return x - y; });
        var fine = rough[Math.floor(rough.length / 2)] / 25;
        trace = traceAt(Math.max(0.008, Math.min(0.05, fine)));
      }
    }

    if (trace.length < 6) { console.log('      too few points'); return; }

    var peak = Math.max.apply(null, trace.map(function (p) { return p.db; }));
    trace.forEach(function (p, n) {
      if (n % 4 && n !== trace.length - 1) return;
      console.log('      ' + p.t.toFixed(2).padStart(6) + 's  ' +
                  (p.db - peak).toFixed(1).padStart(7) + ' dB');
    });

    /*
     * A falling trace starts at its loudest, by definition - so that is the reference.
     *
     * Taking the maximum over the whole window instead let the NEXT note redefine it. A
     * release watched for 1.8 s in a 2 s gap caught the following strike in its last frames,
     * which is 20 dB above anything in the release, and every reading was then measured
     * against the wrong zero: the same release read 22 usable points in one clip and 5 in
     * the next, purely by whether the neighbour bled in.
     *
     * The gap has since been widened so it should not happen at all, and this makes it
     * harmless if it ever does.
     */
    if (!c.rising && trace.length) peak = trace[0].db;

    var floorDb = Math.min.apply(null, trace.map(function (p) { return p.db; }));
    console.log('      it moves ' + (peak - floorDb).toFixed(1) + ' dB');

    /*
     * Not "halfway in decibels", which was what this used to quote.
     *
     * Halfway between the loudest and quietest point of the trace is halfway between two
     * things that depend on how much of the ramp happened to be visible - so the same
     * envelope read over a different span gives a different answer, and two settings cannot
     * be compared. It said VCA attack 70 was 0.43 s and attack 85 was 0.50, which would make
     * fifteen units of the panel worth almost nothing; read properly they are 1.41 and 1.95.
     *
     * A rising level is a straight ramp in GAIN, so every point on it is its own estimate of
     * the ramp's length: t divided by the gain there. Taking the median across the usable
     * part of the trace uses the whole measurement instead of one crossing of it, and the
     * spread says whether it really is a straight ramp - on the hardware those estimates
     * agree to within 3%.
     *
     * A falling level is a straight line in DECIBELS, so it is quoted as the time to fall a
     * fixed twenty of them: unambiguous, well clear of the noise, and independent of where
     * the decay is heading.
     */
    if (c.rising) {
      /*
       * The ramp ends at the first point that reaches the top, and nothing after it counts.
       *
       * Scanning the whole trace for points under nine tenths of full does not do that. Once
       * the window is short enough to resolve a fast rise it is also short enough to be
       * noisy, and on a plateau a few hundred samples long a fair number of windows land
       * under the bar by chance - each one then contributing an estimate of "the ramp" made
       * from a time seconds after it finished. Attack 30 came back at 3.4 s from 2011 points
       * spread 400x, when the rise it was measuring lasts a tenth of one.
       *
       * The rise is monotone, so the first crossing is the end of it, and the plateau is read
       * as the median of the last third rather than the maximum - a maximum over noisy
       * windows is the loudest excursion rather than the level.
       */
      var tail = trace.slice(Math.floor(trace.length * 2 / 3))
                      .map(function (p) { return p.db; })
                      .sort(function (x, y) { return x - y; });
      var full = tail[Math.floor(tail.length / 2)];

      var on = [];
      for (var r = 0; r < trace.length; r++) {
        var gain = Math.pow(10, (trace[r].db - full) / 20);
        if (gain >= 0.9) break;
        if (gain > 0.1) on.push({ t: trace[r].t, g: gain });
      }

      if (on.length < 4) { console.log('      too little of the rise to read'); return; }

      /*
       * A straight line fitted to (time, gain), rather than a median of t divided by gain.
       *
       * t/g assumes the note began exactly when the plan says. It did not: the onset is found
       * from the audio to about ten milliseconds, which is nothing against a ramp of ten
       * seconds and fourteen per cent of one that lasts seventy milliseconds. Every fast clip
       * came out short and scattered because of it, which looks exactly like a curve that is
       * not a straight ramp.
       *
       * Fitting the line lets the onset be an unknown as well. The slope is 1/T whatever the
       * start, and the intercept says where the rise really began - printed when it disagrees
       * with the alignment, because a note that starts late by more than a window is a fact
       * about the take worth knowing.
       */
      var n = on.length, st = 0, sg = 0;
      on.forEach(function (p) { st += p.t; sg += p.g; });
      var mt = st / n, mg = sg / n, num = 0, den = 0;
      on.forEach(function (p) { num += (p.t - mt) * (p.g - mg); den += (p.t - mt) * (p.t - mt); });

      if (den <= 0 || num <= 0) { console.log('      the rise does not rise'); return; }

      var slope = num / den;
      var T = 1 / slope;
      var began = mt - mg / slope;

      var worst = 0;
      on.forEach(function (p) {
        worst = Math.max(worst, Math.abs(p.g - (mg + slope * (p.t - mt))));
      });

      console.log('      a straight ramp of ' + T.toFixed(3) + 's' +
                  '   (' + n + ' points, worst off the line ' + worst.toFixed(3) + ' of full)');
      if (Math.abs(began) > 0.03)
        console.log('      it began ' + (began * 1000).toFixed(0) +
                    ' ms from where the note was placed');
      if (worst > 0.06)
        console.log('      NOT a straight ramp in gain - the points leave the line by ' +
                    worst.toFixed(2) + ' of full scale, so this number is a summary and not a' +
                    ' measurement');

      (result.level || (result.level = [])).push(
        { label: c.label, setting: c.setting, rising: true, seconds: T,
          worst: worst, began: began });
      return;
    }

    /*
     * The fall as a RATE, fitted, and quoted as the time to lose twenty decibels.
     *
     * A single crossing of one threshold carries the onset's error whole - ten milliseconds
     * is nothing on a slow decay and three per cent of a fast one - and throws away every
     * other point in the trace. The decay is a straight line in decibels, so the line is what
     * to fit; the slope is the rate however late the note was found, and the residual says
     * whether it really is straight.
     *
     * The decays in this run are the control that the attacks are read against, so they need
     * to be measured at least as well as the attacks are, or the comparison is between one
     * good number and one rough one.
     */
    var DEPTH = 20;
    var falling = [];
    for (var n2 = 0; n2 < trace.length; n2++) {
      var down = peak - trace[n2].db;
      if (down > DEPTH + 6) break;             // into the sustain floor, no longer falling
      if (down > 1) falling.push({ t: trace[n2].t, db: trace[n2].db });
    }

    if (falling.length < 4) {
      console.log('      it never falls far enough to time');
      return;
    }

    var fn = falling.length, ft = 0, fd = 0;
    falling.forEach(function (p) { ft += p.t; fd += p.db; });
    var fmt = ft / fn, fmd = fd / fn, fnum = 0, fden = 0;
    falling.forEach(function (p) {
      fnum += (p.t - fmt) * (p.db - fmd); fden += (p.t - fmt) * (p.t - fmt);
    });

    var rate = fden > 0 ? -fnum / fden : 0;    // decibels per second, positive going down
    if (rate <= 0) { console.log('      it does not fall'); return; }

    var fworst = 0;
    falling.forEach(function (p) {
      fworst = Math.max(fworst, Math.abs(p.db - (fmd - rate * (p.t - fmt))));
    });

    var fell = DEPTH / rate;
    console.log('      it falls ' + DEPTH + ' dB in ' + fell.toFixed(3) + 's' +
                '   (' + rate.toFixed(1) + ' dB/s over ' + fn + ' points, worst off the line ' +
                fworst.toFixed(1) + ' dB)');
    if (fworst > 2.0)
      console.log('      NOT a straight line in decibels - off by ' + fworst.toFixed(1) +
                  ' dB, so this rate is a summary and not a measurement');

    (result.level || (result.level = [])).push(
      { label: c.label, setting: c.setting, rising: false, seconds: fell,
        depthDb: DEPTH, dbPerSecond: rate, worst: fworst });
  });
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

      // one frequency at a time, unsmoothed - see powerAt
      var base = levelAt (span, startHz * 0.06);     // a long way below the sweep

      trace.push({
        t: t + win / 2,
        db: probes.map(function (hz) { return levelAt (span, hz) - base; })
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

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2));
  console.log('wrote ' + jsonOut);
  console.log("");
}
