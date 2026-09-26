/*
 * The twentieth run: the four constants that are still guesses, and the first run designed
 * from the start not to saturate.
 *
 *   node envdisk.js  build ENVCAL20           --plan envplan20.js
 *   node envmidi.js  AkaiEnvCalibration20.mid --plan envplan20.js
 *   node envcal.js   take.wav ENVCAL20.img    --plan envplan20.js
 *
 * WHAT RUNS 15, 17 AND 19 LEFT BEHIND
 *
 * Every take up to run 17 went through a limiter pinning at -0.49 dBFS, 20 to 30% of all
 * samples in the worst of them. It cost a whole crossfade model, which had to be measured
 * again from scratch. Runs 17 and 19 re-recorded clean and settled the crossfade, the
 * envelope gap, the sustain scale, the decay rule and the velocity step.
 *
 * Four things are still standing on one reading each, and three of the four are LEVEL
 * measurements taken while that limiter was running.
 *
 *   A  VCF_TIME_SCALE = 0.78. "Decay 80 reached the base in 2.25 s against the VCA's 2.86.
 *      One measurement each, so provisional." It decides how fast EVERY filter envelope in
 *      the library runs, and it is a ratio between two clocks, so the only way to measure
 *      it honestly is to read both of them in one take at the same settings.
 *   B  ENV_OCTAVES = 8.5, with two sideways readings from run 5 saying nearer 7.8. It sets
 *      how far the filter envelope travels, so it scales every VCF amount on every disk.
 *   C  LOUDNESS_DB_PER_UNIT = 0.29, from a single stored +20 that read 5.7 dB up - on a
 *      limited take. Zone loudness is set in 1183 of the 1908 library keygroups.
 *   D  Identical-range layers, which are now known NOT to be faded, to within one 0.4 dB
 *      step. The step is unresolved because the S950 SATURATES when two full-level voices
 *      sound together, and no recording level can fix that. This run trims both keygroups
 *      down at source so the machine is not saturating while the ratio is read.
 *
 * WHY A AND B ARE THE SAFE ONES, AND WHY THAT MATTERS
 *
 * The filter is measured by finding its CORNER FREQUENCY, and a limiter distorts amplitude
 * rather than pitch. Corner readings survived what the level readings did not - which is
 * exactly why run 9's envelope TIMES could be trusted as anchors for run 19's rebuild while
 * its span could not. A and B lean on that same robustness deliberately.
 *
 * READ SECTION A AGAINST THE RENDER, NOT AGAINST THE MODEL
 *
 * The dry run says so. Rendering this disk through the emulation and reading it back should
 * return the model exactly, and for everything else here it does - ENV_OCTAVES comes back
 * 8.51 against the 8.5 that went in, and the zone loudness ladder returns 0.29 dB a unit to
 * the decimal. The filter release does not:
 *
 *     stored          50     55     60     65     70
 *     model says   0.239  0.320  0.563  0.687  1.095
 *     read back    0.328  0.404  0.687  0.777  1.172
 *     ratio         1.37   1.26   1.22   1.13   1.07
 *
 * Nothing is wrong with the model there - the render IS the model - so that is the
 * MEASUREMENT's own bias, and it is what a corner found in windows of a twelfth of a second
 * looks like when the corner is moving: every probe is caught late, which costs a fast
 * release proportionally more than a slow one. The four probes within each clip disagree by
 * up to 1.48x for the same reason, and they disagree in the right order, the highest
 * probes reading longest.
 *
 * So the hardware's filter release must be compared against THE RENDER'S, clip for clip,
 * not against the model's number. The bias then cancels, which is the whole reason the
 * render exists. VCF_TIME_SCALE = 0.78 was measured with a tool that has never had its bias
 * characterised; if the 30% is in that reading too, the true scale is nearer 1.0 - which
 * would mean the filter and the amplitude share one clock outright.
 *
 * WHAT THIS RUN CANNOT DO, STATED SO NOBODY LOOKS FOR IT
 *
 * It cannot pin ENV_TIME's absolute scale, and neither can any run. A level measurement
 * yields decibels per second and nothing else, so splitting that into "a table of seconds"
 * and "a span in decibels" has one degree of freedom: scale ENV_TIME by k, scale
 * VCA_RELEASE_DB by k, and not one observable moves. The split is a convention. What is
 * NOT a convention is where the filter's clock sits against the amplitude's, because the
 * filter measures its own travel in octaves - and that is VCF_TIME_SCALE, which is section
 * A. The convention is fixed by run 9's corner-derived times and section A checks it.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

var TONES = [1000, 2200];

/*
 * THE NOISE IS ONE-SHOT AND FULL LENGTH, AND THAT IS NOT A DETAIL.
 *
 * Every filter reading here is a CORNER, and a corner is found by dividing the clip's
 * spectrum by the SOURCE sample's own and looking for where the ratio falls 3 dB. That only
 * works while the two spectra are of the same noise.
 *
 * The first cut of this run reused run 19's noise: 8820 frames, looped. The reference is
 * measured over the whole sample and a clip is measured over a second and a half of it
 * repeating, and at a fifth of a second a band is barely one line wide - so the two
 * estimates of the same noise disagreed by a couple of decibels, wandering smoothly across
 * frequency. The passband ratio came out at -4 dB with +/-2 dB of ripple, which trips a
 * -3 dB threshold on the noise long before the filter gets near it. Every one of the twelve
 * corners read 199 Hz: not a corner at all, but the first place the ripple crossed the bar.
 *
 * Three seconds, unlooped, is what run 1 used and why its corners were solid.
 */
var SAMPLES = [
  { name: 'NOISE', kind: 'noise', frames: 132300, loopMode: 'O' },
  { name: 'T1', kind: 'tone', hz: TONES[0], frames: 4410, loopMode: 'L', loopLength: 4410 },
  { name: 'T2', kind: 'tone', hz: TONES[1], frames: 4410, loopMode: 'L', loopLength: 4410 }
];

/// Byte 21 of the programme header: the crossfade, on - section D needs the same condition
/// run 15 read the layer case under.
var HEADER = { 21: 255 };

/*
 * Where the filter sections start from, carried over from run 1 where they were chosen with
 * the headroom worked out.
 *
 * Stored 20 is 311 Hz, the bottom of the travel, so an envelope that OPENS has the whole
 * range above it. Stored 60 is 4808 Hz, which leaves just under four octaves before the
 * floor, so an envelope that CLOSES has room without reaching it. Stored 50 is high and
 * shallow, which is what a release has to be: a corner has to be FOLLOWED here, in windows
 * of a twelfth of a second, and a window that short cannot resolve a corner near the floor.
 */
var OPEN_FROM = 20;
var CLOSE_FROM = 60;
var RELEASE_FROM = 50;

/*
 * The amounts, the same magnitudes both ways.
 *
 * Six rather than run 1's five, and reaching to 30 rather than 25, because this is the
 * measurement ENV_OCTAVES rests on and the slope wants a long lever. The far ends will not
 * all survive: at 8.5 octaves an amount of 30 takes 311 Hz to 10.7 kHz, comfortably under
 * the 16.3 kHz ceiling, but takes 4808 Hz down to 140 Hz, well under the 311 Hz floor.
 *
 * They are asked for anyway. depth() discards any point sitting on a stop and says so, and
 * a point that turns out to be usable is worth more than one left out of the plan - the
 * whole question is where the travel actually ends, so guessing the limit in advance is the
 * mistake to avoid.
 */
var AMOUNTS = [5, 10, 15, 20, 25, 30];

/*
 * The settings where BOTH clocks can be read.
 *
 * Squeezed at both ends. The filter's corner has to be FOLLOWED, in windows of a twelfth of
 * a second, so anything closing faster than about a tenth of a second is over before the
 * first window and reads the same as instant - which puts the bottom near stored 50, whose
 * filter release is 0.24 s. The amplitude has the opposite problem at the top: the note has
 * to outlast its own release, and the noise sample is three seconds. At stored 70 the level
 * needs 0.66 s to lose the twenty decibels the fit wants and the sample has room; at stored
 * 80 it needs 1.3 s and it has not.
 *
 * So 50 to 70, five rungs, each read twice - once as a filter corner falling and once as a
 * level falling. TWO OF THEM, 50 and 55, overlap run 19's clean VCA ladder, and that is the
 * check that the two takes agree before their ratio is believed at all.
 */
var BOTH = [50, 55, 60, 65, 70];

/*
 * Zone loudness, stored in byte 45 and signed.
 *
 * Eleven rungs from -50 to +50, which at the model's 0.29 dB a unit is a 29 dB span. The
 * whole section is played at velocity 100 through a velocity-to-loudness of 99, which puts
 * it 17 dB down before zone loudness is applied at all - so even +50 lands nowhere near the
 * ceiling. Every keygroup here shares that, so it cancels out of the slope entirely.
 */
var LOUDNESS = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50];

var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  12: 0, 13: 0, 14: 0,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  19: 0xFF,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,     // the filter envelope instant on, and it stays on
  43: 0,
  44: 99, 45: 0
};

var TIMING = {
  hold: 1.0,
  gap: 0.8,          // the SHORTEST gap in the run - what the note splitter is tuned to
  sectionGap: 2.0,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var KEYGROUPS = [];

/// A signed byte as the disk stores it.
function signed(v) { return ((v % 256) + 256) % 256; }

function keygroup(low, high, sample, extra) {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(extra || {}).forEach(function (k) { set[k] = extra[k]; });
  set[0] = high; set[1] = low;
  KEYGROUPS.push({ low: low, high: high, set: set, sample: sample,
                   why: sample + ' over keys ' + low + ' to ' + high });
}

function note(spec) {
  TESTS.push({
    section: spec.section, analysis: spec.analysis, label: spec.label,
    key: spec.key, velocity: spec.velocity === undefined ? 127 : spec.velocity,
    hold: spec.hold, gapAfter: spec.gapAfter,
    setting: spec.setting, rising: !!spec.rising, watch: spec.analysis, why: spec.why
  });
}

/*
 * A. THE TWO CLOCKS, READ IN ONE TAKE.
 *
 * VCF_TIME_SCALE is a RATIO - how much quicker the filter's envelope runs than the
 * amplitude's for the same stored byte - and the only honest way to measure a ratio between
 * two clocks is to read both of them at the same settings in the same recording. It has
 * never been done: the 0.78 in the model is one filter decay from one run set against one
 * amplitude decay from another.
 *
 * A1, the filter falling. Based high and shallow, with an amount of 15, so the cutoff runs
 * from about 9 kHz down to 1.9 kHz - two and a quarter octaves, all of it far enough above
 * the floor to be resolved in the short windows a moving corner needs. The AMPLITUDE
 * release is long here, stored 80, because the filter can only be measured while there is
 * still a note to measure it on.
 */
var keyA = 24;
BOTH.forEach(function (r) {
  keygroup(keyA, keyA, 'NOISE', { 44: RELEASE_FROM, 23: 15, 37: r, 6: 80 });
  note({ section: 'vcf release', analysis: 'release', label: 'VCF release ' + r,
         key: keyA, hold: 1.0, gapAfter: 2.5, setting: r,
         why: 'the filter clock, in seconds, from a corner that a limiter cannot touch' });
  keyA++;
});

/*
 * A2, the amplitude falling, at the same six settings. Filter wide open and out of the way,
 * sustain at full so the note is at a known level when the key comes up.
 *
 * The section name has to begin with "release" - that is what tells the level analysis to
 * trace from the key coming UP rather than from the strike.
 */
var keyA2 = 32;
BOTH.forEach(function (r) {
  keygroup(keyA2, keyA2, 'NOISE', { 6: r });
  note({ section: 'release ' + r, analysis: 'level', label: 'VCA release ' + r,
         key: keyA2, hold: 0.8, gapAfter: 2.0, setting: r,
         why: r <= 55 ? 'overlaps run 19 - the check that the two takes agree'
                      : 'the amplitude clock at the same setting as the filter' });
  keyA2++;
});

/*
 * B. HOW FAR THE FILTER ENVELOPE TRAVELS - ENV_OCTAVES.
 *
 * Static corners, held still and read over a long window, which is the most reliable thing
 * this rig does. The envelope is instant-on and stays on, so the cutoff simply sits where
 * the amount puts it and the only question is how far from the base that is.
 *
 * 8.5 is in the model and two sideways readings from run 5 say nearer 7.8 - neither clean
 * enough to change a constant on, because neither was what that run was for. Six amounts
 * each way, fitted as a slope rather than read off one point, is what makes this one clean.
 */
var keyB = 40;
AMOUNTS.forEach(function (a) {
  keygroup(keyB, keyB, 'NOISE', { 44: OPEN_FROM, 23: a });
  note({ section: 'opening', analysis: 'opening', label: 'amount +' + a,
         key: keyB, hold: 2.0, gapAfter: 1.0, setting: a,
         why: 'how far a positive amount opens the filter, from the bottom of the travel' });
  keyB++;
});

var keyB2 = 48;
AMOUNTS.forEach(function (a) {
  keygroup(keyB2, keyB2, 'NOISE', { 44: CLOSE_FROM, 23: signed(-a) });
  note({ section: 'closing', analysis: 'closing', label: 'amount -' + a,
         key: keyB2, hold: 2.0, gapAfter: 1.0, setting: -a,
         why: 'and whether a negative amount goes as far the other way' });
  keyB2++;
});

/*
 * C. ZONE LOUDNESS - LOUDNESS_DB_PER_UNIT.
 *
 * Byte 45, signed, set in 1183 of the library's 1908 keygroups. The model has 0.29 dB per
 * unit from a single stored +20 that read 5.7 dB up, on a take that was being limited; an
 * earlier figure of 0.21 came from the emulation measuring itself, which is worth recording
 * as the kind of mistake this whole rig exists to avoid.
 *
 * One keygroup per rung, one key each, read as levels against each other. The velocity trim
 * on every keygroup here is the same, so it cancels: it is only there to put the section 17
 * decibels down, so that a zone loudness of +50 has somewhere to go.
 */
var keyC = 56;
LOUDNESS.forEach(function (v) {
  keygroup(keyC, keyC, 'T1', { 11: 99, 45: signed(v) });
  note({ section: 'zone loudness', analysis: 'mix', label: 'zone loudness ' + v,
         key: keyC, velocity: 100, hold: 1.0, gapAfter: 0.8, setting: v,
         why: 'the decibels a unit of zone loudness is worth' });
  keyC++;
});

/*
 * D. THE LAYER CASE, WITH THE MACHINE KEPT OUT OF SATURATION.
 *
 * Two keygroups on exactly the same keys are not faded - run 15 bounded each of them above
 * -0.71 dB, which on the 0.4 dB grid is zero steps or one, and the engines now use zero.
 * What stopped it being settled outright is that the S950 DISTORTS ITS OWN OUTPUT when two
 * full-level voices sound together: dropping the recording level 2.66 dB left every other
 * section of run 15 clean and changed this one's reading not at all.
 *
 * So the pair is turned down at SOURCE. Zone loudness -40 on all four keygroups here, which
 * at even the lowest estimate of 0.21 dB a unit is 8.4 dB, and at the model's 0.29 is 11.6.
 * A pair sums 3 dB above one of them and their crests align 6 dB above, so 8 dB of headroom
 * is enough and 11 is comfortable.
 *
 * The two SOLO keygroups carry exactly the same trim, so whatever a unit of zone loudness
 * turns out to be worth - which is section C's question, not this one's - it cancels out of
 * the ratio completely. This section does not depend on section C succeeding.
 */
keygroup(100, 108, 'T1', { 45: signed(-40) });
keygroup(100, 108, 'T2', { 45: signed(-40) });
keygroup(112, 116, 'T1', { 45: signed(-40) });
keygroup(120, 124, 'T2', { 45: signed(-40) });

[102, 104, 106].forEach(function (k) {
  note({ section: 'same range', analysis: 'mix', label: 'layered, key ' + k,
         key: k, hold: 1.0, gapAfter: 0.8, setting: k,
         why: 'two keygroups on the same keys, quiet enough not to saturate' });
});
note({ section: 'same range', analysis: 'mix', label: '1000 Hz alone',
       key: 114, hold: 1.0, gapAfter: 0.8, setting: 114,
       why: 'the same keygroup and the same trim, sounding by itself' });
note({ section: 'same range', analysis: 'mix', label: '2200 Hz alone',
       key: 122, hold: 1.0, gapAfter: 0.8, setting: 122,
       why: 'and the other one' });

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

/// Section D's two keygroups cover exactly the same keys, so the overlap is that whole range.
function overlaps() {
  return [{ section: 'same range', from: 100, to: 108 }];
}

function keygroups() { return KEYGROUPS; }
function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, HEADER: HEADER, LOOPING: true, SAMPLES: SAMPLES,
  TONES: TONES, overlaps: overlaps,
  AMOUNTS: AMOUNTS, BOTH: BOTH, LOUDNESS: LOUDNESS,
  FROM: 99, OPEN_FROM: OPEN_FROM, CLOSE_FROM: CLOSE_FROM, RELEASE_FROM: RELEASE_FROM,
  AMOUNT: 0,
  schedule: schedule, keygroups: keygroups, clips: clips
};
