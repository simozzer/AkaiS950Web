/*
 * The second filter run: what the first one could not settle.
 *
 *   node envdisk.js build ENVCAL2 --plan envplan2.js
 *   node envmidi.js AkaiEnvCalibration2.mid --plan envplan2.js
 *   node envcal.js take.wav ENVCAL2.img --plan envplan2.js
 *
 * The first run answered the question it was built for. The depth of the filter envelope is
 * 8.3 octaves at full amount, not the 7.6 the model carried; it is straight to within 0.013
 * octaves over four points; and it is symmetric to 1%, so a negative amount really does
 * invert the envelope and go exactly as far. None of that needs asking again.
 *
 * It left two things open, and neither can be answered from the same disk.
 *
 * WHERE THE CUTOFF CURVE DISAGREES WITH ITSELF
 *
 * Stored 50 measured 2211 Hz here. The model's table says 1878, and that number came from
 * the PREVIOUS hardware take - from its key-tracking clip, which had keyToFilter at 50. This
 * run measured the same setting with tracking off. Two hardware measurements of one setting
 * differing by a quarter of an octave means one of them has a term in it that nobody has
 * accounted for, and the obvious suspect is that key tracking does not pivot where the model
 * assumes: it takes the cutoff as written at note 60, and nothing has ever tested that.
 *
 * So: the same keygroup settings, at five keys spanning four octaves, with tracking on - and
 * the same five keys again with tracking off as controls. The controls must all read the
 * same number, because with constant pitch nothing else depends on the key. Whatever the
 * tracked ones do against them is the tracking, pivot and all.
 *
 * WHY THE RELEASE MEASURED NOTHING
 *
 * Releases of 50, 60 and 70 all swept the filter down within about a sixteenth of a second,
 * where the model predicted 0.14, 0.35 and 0.88. The machine's filter release is far faster
 * than the model thinks, which is why three settings an octave apart in the model looked
 * identical on the recording: they were all over before the measurement could see them.
 *
 * This time the settings start where the first run ran out - 70 and above - so the sweeps
 * are slow enough to follow.
 */

var VEL = 100;
var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,
  43: 0,
  44: 99, 45: 0
};

/*
 * Stored 50 for the tracking work, because that is the setting the two takes disagree about.
 * Settle it where the argument is rather than somewhere more convenient.
 */
var TRACK_FILTER = 50;

/*
 * The keys the tracking is measured at, four octaves of them.
 *
 * Wide on purpose: the pivot is an offset, and an offset is only visible against a slope
 * measured over a long enough span to be sure of. Two octaves either side of middle C is as
 * much as the machine's own keyboard offers.
 */
var TRACK_KEYS = [36, 48, 60, 72, 84];

/*
 * The release, from where the first run ran out.
 *
 * Under the model these are 0.9, 2.3, 5.8 and 16 seconds. On the evidence of the first take
 * they will all be far shorter than that - which is the point: the first run's 50, 60 and 70
 * were all gone inside a sixteenth of a second, so the usable settings must be higher.
 */
var RELEASES = [70, 80, 90, 99];
var RELEASE_FROM = 50;
var RELEASE_AMOUNT = 12;

var TIMING = {
  hold: 3.0,
  releaseHold: 1.0,
  gap: 2.5,
  sectionGap: 4.0,
  lead: 1.0,
  channel: 0
};

var TESTS = [];

function test(spec) {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(spec.set || {}).forEach(function (k) { set[k] = spec.set[k]; });

  TESTS.push({
    section: spec.section, analysis: spec.analysis, label: spec.label,
    key: spec.key, velocity: VEL, hold: spec.hold || TIMING.hold,
    set: set, why: spec.why, setting: spec.setting
  });
}

/*
 * 1. The controls: the same cutoff at five keys, with tracking OFF.
 *
 * These must all read the same. Constant pitch means the sample plays identically whatever
 * key is struck, and with keyToFilter at nothing the key cannot reach the filter either - so
 * a spread here would mean something else in this rig depends on the note, and every
 * tracking number would be built on it.
 */
TRACK_KEYS.forEach(function (key) {
  test({
    section: 'no tracking', analysis: 'control', label: 'note ' + key,
    setting: key, key: key,
    set: { 44: TRACK_FILTER, 8: 0 },
    why: 'the cutoff as written, at ' + key + ', with the key unable to reach it'
  });
});

/*
 * 2. The same again with tracking at 50 - the library's own default, and the setting the
 * disputed measurement used.
 */
TRACK_KEYS.forEach(function (key) {
  // a semitone up, because the control already owns that key and a keygroup is one key
  // wide here - the measurement is of whatever note is actually struck, so it says so
  var played = key + 1;
  test({
    section: 'tracking 50', analysis: 'tracking', label: 'note ' + played,
    setting: played, key: played,
    set: { 44: TRACK_FILTER, 8: 50 },
    why: 'what tracking does to it at ' + played
  });
});

/*
 * 3. The release, slowly enough to watch this time.
 */
RELEASES.forEach(function (r, i) {
  test({
    section: 'release', analysis: 'release', label: 'release ' + r,
    setting: r, key: 96 + i, hold: TIMING.releaseHold,
    set: { 44: RELEASE_FROM, 23: RELEASE_AMOUNT, 37: r, 6: 80 },
    why: 'how long a release of ' + r + ' really takes'
  });
});

function schedule() {
  var events = [];
  var clips = [];
  var at = TIMING.lead;
  var section = null;

  TESTS.forEach(function (c) {
    var first = c.section !== section;
    if (clips.length) at += first ? TIMING.sectionGap : TIMING.gap;
    section = c.section;

    events.push({ at: at, kind: 'on', note: c.key, velocity: c.velocity });
    events.push({ at: at + c.hold, kind: 'off', note: c.key });

    clips.push({
      section: c.section, analysis: c.analysis, label: c.label, setting: c.setting,
      note: c.key, velocity: c.velocity, first: first,
      from: at, releasedAt: at + c.hold, hold: c.hold
    });

    at += c.hold;
  });

  return { events: events, clips: clips, seconds: at + TIMING.gap };
}

function keygroups() {
  return TESTS.map(function (c) {
    return { low: c.key, high: c.key, set: c.set, why: c.why, sample: 'NOISE' };
  });
}

function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE,
  TRACK_KEYS: TRACK_KEYS, TRACK_FILTER: TRACK_FILTER,
  RELEASES: RELEASES, RELEASE_FROM: RELEASE_FROM, RELEASE_AMOUNT: RELEASE_AMOUNT,
  schedule: schedule, keygroups: keygroups, clips: clips
};
