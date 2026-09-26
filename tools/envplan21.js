/*
 * The twenty-first run: the filter's clock, measured against a steady level.
 *
 *   node envdisk.js  build ENVCAL21           --plan envplan21.js
 *   node envmidi.js  AkaiEnvCalibration21.mid --plan envplan21.js
 *   node envcal.js   take.wav ENVCAL21.img    --plan envplan21.js
 *
 * WHY RUN 20 COULD NOT SETTLE THIS
 *
 * VCF_TIME_SCALE says how much quicker the filter's envelope runs than the amplitude's for
 * the same stored byte. It has been 0.78 since one filter decay was set against one
 * amplitude decay, and it scales every filter envelope on every disk.
 *
 * Run 20 read both clocks in one take and the amplitude side was solid - it agreed with run
 * 19 to 1.7%. The filter side came out at 0.74 of the same disk rendered through the model,
 * which would put the scale near 0.58. But the four probes inside each clip disagreed by up
 * to 3.4x, and the disagreement GREW with the setting:
 *
 *     stored          50     55     60     65     70
 *     probes differ  1.48   1.71   2.30   2.92   3.43
 *
 * That pattern is the fault, and it was mine. Run 20 watched the filter's RELEASE, which
 * only happens after the key comes up - and the amplitude is released at the same moment.
 * The note was dying at 15 dB a second underneath the measurement, so the longer the filter
 * took, the less signal was left to find its corner in, and the highest probes were read
 * when there was least to read them from.
 *
 * WHAT THIS RUN DOES INSTEAD
 *
 *   A  THE FILTER'S DECAY, watched from the STRIKE. A decay happens while the key is still
 *      down, so the amplitude can be held dead flat underneath it - attack 0, decay 0,
 *      sustain 99, release 0 - and the corner is followed through a note that does not
 *      change level at all. No droop, and nothing to grow with the setting.
 *   B  THE AMPLITUDE'S DECAY at the same five settings, so the ratio is read in one take
 *      from the same stage of the same envelope rather than across two runs.
 *   C  THE FILTER'S RELEASE at those settings as well, but with the amplitude release at 99
 *      rather than 80 - 4 dB a second instead of 15. Run 20's measurement repeated with the
 *      fault taken out, which says how much of its scatter really was the droop.
 *   D  IS THE FILTER'S DECAY A RATE OR A DURATION? Run 19 asked this of the amplitude and
 *      got a clear answer: a rate, 48.2 dB/s at every one of twelve sustain depths. The
 *      filter's is modelled as a DURATION and nobody has ever checked. Four sustains at one
 *      decay setting settle it, and it costs four notes.
 *
 * D is the one that could move more than a constant. If the filter's decay turns out to be
 * a rate too, then one generator drives both and VCF_TIME_SCALE is the only thing that
 * separates them - which would be worth knowing before trusting any number this run
 * produces for it.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

/*
 * ONE-SHOT AND FULL LENGTH. Every reading here is a corner, and a corner is found by
 * dividing the clip's spectrum by the source sample's own - which only works while the two
 * are of the same noise. Run 20's first cut looped a fifth of a second of it and every
 * corner in the run came back as the same wrong number. See envplan20.js.
 */
var SAMPLES = [
  { name: 'NOISE', kind: 'noise', frames: 132300, loopMode: 'O' }
];

/*
 * Where the filter starts from, and how far it travels.
 *
 * Stored 50 is about 2.2 kHz, and an amount of 15 is 2.5 octaves at the ENV_OCTAVES run 20
 * measured - so the cutoff starts near 12 kHz and falls to 2.2. The whole sweep is high,
 * which is what a MOVING corner needs: it has to be resolved in short windows, and the
 * bands near the 311 Hz floor have barely a handful of cycles in one.
 */
var FROM = 50;
var AMOUNT = 15;

/*
 * The settings, chosen by what both clocks can resolve at once.
 *
 * Below 50 the filter is done before the first window. Above 70 the note runs out: the
 * sample is three seconds and a decay of 75 would want most of them.
 */
var STORED = [50, 55, 60, 65, 70, 75];

/*
 * AND READ THE FITTED RAMP, NOT THE ARRIVAL TIME.
 *
 * The trajectory analysis reports both. The arrival - "within a twentieth of an octave of
 * the end by" - is quantised to the window and jumps in 0.125 s steps, which is 50% at the
 * bottom of this ladder. The straight-line fit uses every point on the ramp instead, and
 * the dry run shows it carrying a near-constant lag of about 0.2 s rather than a
 * proportional error:
 *
 *     stored        50     55     60     65     70
 *     model       0.239  0.320  0.563  0.687  1.095
 *     fitted ramp  0.47   0.51   0.75   0.84   1.23
 *     difference   0.23   0.19   0.19   0.15   0.14
 *
 * That lag is the window smearing a moving corner and it belongs to the METHOD, so the
 * hardware has to be read against the render clip for clip - the same rule run 20 arrived
 * at, for the same reason. With it taken out the fit is good to a few hundredths of a
 * second, which at stored 65 and above is better than five per cent.
 */

/// Section D: one decay setting, four depths for it to fall through.
var DEPTHS = [0, 25, 50, 75];

/*
 * Sections E and F: the two things every filter measurement so far has held fixed.
 *
 * WHERE IT STARTS. Every filter clip in every run has swept from one base - run 1 and run
 * 20 used stored 20 and 60 for their static depths, and every timing measurement ever made
 * has used a single base. So nobody knows whether the envelope takes the same TIME from a
 * different starting cutoff. It should, if the envelope is a number of octaves per second;
 * it would not if the machine is counting in cutoff-code units, where the same count spans
 * a different number of octaves depending where you begin. Three bases two octaves apart
 * answer it.
 *
 * WHICH WAY IT GOES. Run 20 measured the static depth both ways and found them within 2%,
 * so a negative amount travels as far. It says nothing about how LONG it takes to get
 * there, and up and down could perfectly well be separate mechanisms.
 *
 * Only stored 50 leaves room in both directions at amount 15 - from 2210 Hz it reaches
 * 12.4 kHz going up and 393 Hz coming down, both inside the stops, and every other base
 * clips one way or the other. So the sign comparison happens there, with one clip from a
 * higher base as a check that starting near the bottom is not distorting it.
 */
var BASES = [30, 40, 50];
var NEGATIVE = [60, 65, 70];

var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,          // the amplitude flat and held - nothing moves under it
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  12: 0, 13: 0, 14: 0,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  19: 0xFF,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,
  43: 0,
  44: 99, 45: 0
};

var TIMING = {
  hold: 2.5,
  gap: 1.0,          // the SHORTEST gap in the run - what the note splitter is tuned to
  sectionGap: 2.0,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var KEYGROUPS = [];

function keygroup(low, high, extra) {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(extra || {}).forEach(function (k) { set[k] = extra[k]; });
  set[0] = high; set[1] = low;
  KEYGROUPS.push({ low: low, high: high, set: set, sample: 'NOISE',
                   why: 'NOISE over keys ' + low + ' to ' + high });
}

function note(spec) {
  TESTS.push({
    section: spec.section, analysis: spec.analysis, label: spec.label,
    key: spec.key, velocity: 127,
    hold: spec.hold, gapAfter: spec.gapAfter,
    setting: spec.setting, rising: !!spec.rising, watch: spec.analysis, why: spec.why
  });
}

/*
 * A. THE FILTER'S DECAY, WITH NOTHING MOVING UNDERNEATH IT.
 *
 * VCF attack 0 so the envelope starts at full, VCF sustain 0 so it falls the whole way, and
 * the amplitude left exactly as BASE has it - flat at full for the length of the note. The
 * corner starts near 12 kHz and walks down to 2.2, and the level it is measured against
 * does not move by a decibel while it does.
 *
 * The section must NOT be called "release": that is the word that tells the trajectory
 * analysis to watch from the key coming up. These are watched from the strike.
 */
var keyA = 24;
STORED.forEach(function (s) {
  keygroup(keyA, keyA, { 44: FROM, 23: AMOUNT, 35: s, 36: 0 });
  note({ section: 'vcf decay', analysis: 'trajectory', label: 'VCF decay ' + s,
         key: keyA, hold: 2.5, gapAfter: 1.0, setting: s,
         why: 'the filter clock, read against a level that is not falling' });
  keyA++;
});

/*
 * B. THE AMPLITUDE'S DECAY, at the same five settings.
 *
 * Same stage, same envelope byte, same take - which is what makes the ratio a measurement
 * rather than a comparison across two sessions. Sustain 0 so it falls as far as it goes;
 * the filter is wide open and out of the way.
 *
 * Run 19 read stored 50 and 55 on its own clean take, so those two rungs also say whether
 * this take agrees with that one before anything is divided by anything.
 */
var keyB = 32;
STORED.forEach(function (s) {
  keygroup(keyB, keyB, { 4: s, 5: 0 });
  note({ section: 'vca decay', analysis: 'level', label: 'VCA decay ' + s,
         key: keyB, hold: 2.5, gapAfter: 1.0, setting: s,
         why: s <= 55 ? 'overlaps run 19 - the check that the takes agree'
                      : 'the amplitude clock at the same setting as the filter' });
  keyB++;
});

/*
 * C. THE FILTER'S RELEASE, the way run 20 measured it but with the droop taken out.
 *
 * Amplitude release 99 rather than 80: four decibels a second instead of fifteen, so the
 * note is still 8 dB up two seconds after the key comes up rather than 30 dB down. If run
 * 20's probe scatter was the droop, it should collapse here; if it does not, the fault is
 * somewhere else and section A is the only one of the two to believe.
 */
var keyC = 40;
STORED.forEach(function (s) {
  keygroup(keyC, keyC, { 44: FROM, 23: AMOUNT, 37: s, 6: 99 });
  note({ section: 'release', analysis: 'release', label: 'VCF release ' + s,
         key: keyC, hold: 1.0, gapAfter: 2.5, setting: s,
         why: 'run 20 again, with the note no longer dying under the measurement' });
  keyC++;
});

/*
 * D. IS THE FILTER'S DECAY A RATE OR A DURATION?
 *
 * One decay setting, four depths for it to cover. The amplitude's decay turned out to be a
 * RATE - run 19 held it at stored 65 and moved the sustain through twelve settings, and
 * every one fell at 48.2 dB per second. The filter's is modelled as a DURATION, purely
 * because that is how it was written before anybody measured either.
 *
 * A duration puts every one of these at its plateau at the same moment, whatever depth it
 * had to cover. A rate gets the shallow ones there sooner, in proportion. Four notes.
 *
 * Decay 65 because it is the middle of the measurable range and the setting run 19 used for
 * the same question, so the two answers can be set side by side.
 */
var keyD = 48;
DEPTHS.forEach(function (v) {
  keygroup(keyD, keyD, { 44: FROM, 23: AMOUNT, 35: 65, 36: v });
  note({ section: 'vcf depth', analysis: 'trajectory', label: 'VCF sustain ' + v,
         key: keyD, hold: 2.5, gapAfter: 1.0, setting: v,
         why: 'a duration lands them together, a rate lands the shallow ones first' });
  keyD++;
});

/*
 * E. DOES IT TAKE THE SAME TIME FROM A DIFFERENT STARTING CUTOFF?
 *
 * One decay setting and one amount, three bases two octaves apart: stored 30 is 544 Hz,
 * 40 is 1138 and 50 is 2210. Each sweeps the same 2.5 octaves, just from somewhere else.
 *
 * If the envelope is octaves per second the three come back identical. If the machine is
 * counting in cutoff-code units instead - which is what the stored byte actually is - then
 * the same count covers a different number of octaves depending where it starts, and these
 * three will not agree. That would be a different model, not a different constant.
 */
var keyE = 54;
BASES.forEach(function (b) {
  keygroup(keyE, keyE, { 44: b, 23: AMOUNT, 35: 65, 36: 0 });
  note({ section: 'vcf base', analysis: 'trajectory', label: 'base ' + b,
         key: keyE, hold: 2.5, gapAfter: 1.0, setting: b,
         why: 'whether the filter clock cares where the sweep starts' });
  keyE++;
});

/*
 * F. AND DOES IT TAKE THE SAME TIME GOING THE OTHER WAY?
 *
 * Amount -15 from the same base of 50, so the envelope pulls the cutoff DOWN to 393 Hz and
 * the decay brings it back UP to 2210. Run 20 showed a negative amount travels as far as a
 * positive one, to 2%; this asks whether it does it as fast.
 *
 * Three settings rather than one, because a single pair cannot tell a constant offset from
 * a constant ratio - and if up and down really are separate mechanisms, the difference is
 * more likely to grow with the setting than to sit still.
 *
 * The last clip is the same question from stored 55, whose sweep bottoms at 578 Hz rather
 * than 393. The trajectory analysis refuses a corner that comes too close to the reference
 * bands it levels against, and 393 Hz is only 1.4 octaves above them - so if the low start
 * is eating the beginning of the ramp, the higher one will disagree with it and say so.
 */
var keyF = 60;
NEGATIVE.forEach(function (s) {
  keygroup(keyF, keyF, { 44: 50, 23: (256 - AMOUNT) & 0xFF, 35: s, 36: 0 });
  // RISING. A negative amount pulls the cutoff below the base, so the decay brings it back
  // UP - and the trajectory analysis needs telling, because it normalises the sweep as a
  // fraction of its own travel and would otherwise fit both shapes back to front.
  note({ section: 'vcf negative', analysis: 'trajectory', label: 'amount -15, decay ' + s,
         key: keyF, hold: 2.5, gapAfter: 1.0, setting: s, rising: true,
         why: 'the same travel in the other direction - as fast, or not?' });
  keyF++;
});

keygroup(keyF, keyF, { 44: 55, 23: (256 - AMOUNT) & 0xFF, 35: 65, 36: 0 });
note({ section: 'vcf negative', analysis: 'trajectory', label: 'amount -15 from a higher base',
       key: keyF, hold: 2.5, gapAfter: 1.0, setting: 65, rising: true,
       why: 'the same clip starting 1.6 octaves higher, in case the low start distorts it' });

function schedule() {
  var events = [];
  var clips = [];
  var at = TIMING.lead;
  var section = null;
  var previous = null;

  TESTS.forEach(function (c) {
    var first = c.section !== section;
    if (clips.length)
      at += first ? Math.max(TIMING.sectionGap, previous.gapAfter) : previous.gapAfter;
    section = c.section;
    previous = c;

    events.push({ at: at, kind: 'on', note: c.key, velocity: c.velocity });
    events.push({ at: at + c.hold, kind: 'off', note: c.key });

    clips.push({
      section: c.section, analysis: c.analysis, label: c.label, setting: c.setting,
      note: c.key, velocity: c.velocity, first: first, rising: c.rising, watch: c.watch,
      from: at, releasedAt: at + c.hold, hold: c.hold, gapAfter: c.gapAfter
    });

    at += c.hold;
  });

  return { events: events, clips: clips, seconds: at + 3.0 };
}

function keygroups() { return KEYGROUPS; }
function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, LOOPING: false, SAMPLES: SAMPLES,
  STORED: STORED, DEPTHS: DEPTHS,
  FROM: FROM, OPEN_FROM: FROM, CLOSE_FROM: FROM, RELEASE_FROM: FROM, AMOUNT: AMOUNT,
  schedule: schedule, keygroups: keygroups, clips: clips
};
