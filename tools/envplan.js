/*
 * The filter envelope run, described once.
 *
 * ENVCAL builds its own disk, its own MIDI file and its own analysis from this, the way
 * LFOCAL does, so nothing here can drift apart from what is actually played.
 *
 * WHAT IS NOT KNOWN, AND WHY THIS EXISTS
 *
 * The depth of the filter envelope - CAL.ENV_OCTAVES - has never been measured cleanly.
 * The calibration run asked for amounts of 25 and 50 from a base of stored 40, and both
 * clips started hard against the 16.3 kHz stop, so neither showed its own peak. The figure
 * in use, 7.6 octaves, was recovered from the SLOPE of the sweeps below the stop and is
 * good to about 2% between the two - but it is an extrapolation, and the value it replaced
 * was 6.2, so the error it corrected was 23%.
 *
 * Negative amounts have never been measured at all. The byte is signed, three keygroups in
 * the library use it, and the model assumes the depth is symmetric about zero purely
 * because there is no reason to think otherwise. That is an assumption of exactly the kind
 * this project has twice found to be wrong.
 *
 * And the filter's release is new. Its time scale is borrowed from the decay's.
 *
 * HOW IT AVOIDS THE TRAP THE LAST RUN FELL INTO
 *
 * Every clip here holds its cutoff STILL. The envelope is set to instant attack and full
 * sustain, so it rises at once and stays there for the whole note, and what is measured is
 * a steady -3 dB corner rather than a moving one. A static corner is the most reliable
 * thing this rig measures - the original ladder recovered its six points exactly - where a
 * sweep has to be traced through short windows and read off a trend.
 *
 * And the bases are chosen for headroom in the direction being measured: the opening tests
 * start at the bottom of the filter's travel and the closing tests near the top, so the
 * envelope has somewhere to go and nothing lands on a stop.
 */

var VEL = 100;

/*
 * Keygroup bytes, by offset - the same map lfoplan.js uses.
 *
 *    3..6  VCA attack / decay / sustain / release      7  vel -> filter
 *       8  key -> filter         11  vel -> loudness   18  flags
 *      23  VCF amount            34..37  VCF attack / decay / sustain / release
 *      43  zone 1 transpose      44  zone 1 filter     45  zone 1 loudness
 */
var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

/*
 * What every keygroup starts from.
 *
 * Constant pitch matters more here than anywhere else in this project: the filter's ceiling
 * moves with the rate the audio leaves at, so a keygroup that transposed with the key would
 * give every clip a different stop. With it set, every note plays the sample at its own
 * rate and the ceiling is the same number for all of them.
 *
 * The gate is flat - instant attack, no decay, full sustain - so the level is steady and
 * cannot be mistaken for the filter doing something. Velocity drives nothing, and the
 * pivot is at 65, so it could: at velToFilter 99 a velocity of 100 is worth 2.3 octaves.
 */
var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,      // instant on, and it stays on
  43: 0,
  44: 99, 45: 0
};

/*
 * Where the opening and closing tests start from.
 *
 * Stored 20 is the bottom of the filter's travel - 311 Hz, the floor - so an envelope that
 * opens has the whole range above it. Stored 60 is 4808 Hz, which leaves 3.95 octaves below
 * before the floor, so an envelope that closes has room without reaching it.
 */
var OPEN_FROM = 20;
var CLOSE_FROM = 60;

/*
 * The release tests start here instead - high, and shallow. See the release section.
 */
var RELEASE_FROM = 50;

/*
 * The amounts asked for, the same magnitudes in both directions.
 *
 * They stop at 25 because that is what the headroom allows: at the model's 7.6 octaves an
 * amount of 25 is 3.8 octaves, which takes 311 Hz to 4.3 kHz and 4808 Hz back to 345 Hz.
 * Both are clear of a stop. An amount of 30 would put the closing test under the floor and
 * measure nothing but the clamp, which is the mistake this run exists to avoid.
 *
 * Five points rather than two, because a single pair cannot tell a straight line from a
 * curve - and whether the depth is linear in the amount is itself one of the questions.
 */
var AMOUNTS = [5, 10, 15, 20, 25];

/*
 * The filter's release, in stored units, and what the model says they are in seconds:
 *
 *     0 -> 1.3 ms     50 -> 137 ms     60 -> 347 ms     70 -> 886 ms
 *
 * Chosen for what the measurement can actually resolve. Finding a corner near 300 Hz needs
 * something like a twelfth of a second of audio, so anything that closes faster than about
 * a tenth of a second is over before the first window and reads the same as instant: a run
 * with 0 and 30 in it returned the same answer for both, which is true and useless.
 *
 * Zero stays, as the control at the bottom - it should show the filter already shut in the
 * first window, which is what says the release exists at all. The other three span a factor
 * of six and are all comfortably inside the note's own tail. A stored 80 would be 2.3
 * seconds, longer than what is left of a three-second sample after the key comes up, so it
 * would measure the sample running out rather than the filter closing.
 */
var RELEASES = [0, 50, 60, 70];

var TIMING = {
  hold: 3.0,              // the sample is 3 s, so a held clip lasts the whole of it
  releaseHold: 1.0,       // the release clips let go early, to leave room for the tail
  gap: 2.5,               // long enough to outlast the longest release and still split
  sectionGap: 4.0,        // a longer pause where a section starts, visible in a take
  lead: 1.0,
  channel: 0
};

// --------------------------------------------------------------------- the tests

var TESTS = [];
var FIRST_KEY = 36;
var nextKey = FIRST_KEY;

function test(spec) {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(spec.set || {}).forEach(function (k) { set[k] = spec.set[k]; });

  TESTS.push({
    section: spec.section, analysis: spec.analysis, label: spec.label,
    key: nextKey++, velocity: VEL,
    hold: spec.hold || TIMING.hold,
    set: set, why: spec.why, setting: spec.setting
  });
}

/*
 * 1. The cutoff curve, at the five settings nobody has measured.
 *
 * The original ladder did 0, 20, 40, 60, 80 and 99, and the table in CAL interpolates
 * between them in log frequency. These are the midpoints of the gaps - and the gap from 20
 * to 40 is where the curve leaves the floor, which is the least straight part of it.
 */
[10, 30, 50, 70, 90].forEach(function (stored) {
  test({
    section: 'cutoff curve', analysis: 'curve', label: 'stored ' + stored,
    setting: stored,
    set: { 44: stored },
    why: 'a point the CAL table has to guess at'
  });
});

/*
 * 2. Opening: a positive amount, from the bottom of the travel.
 */
AMOUNTS.forEach(function (a) {
  test({
    section: 'opening', analysis: 'opening', label: 'amount +' + a,
    setting: a,
    set: { 44: OPEN_FROM, 23: a },
    why: 'how far ' + a + ' of amount lifts the cutoff'
  });
});

/*
 * 3. Closing: the same amounts negative, from near the top.
 *
 * Byte 23 is signed, so a negative amount is written as the two's complement.
 */
AMOUNTS.forEach(function (a) {
  test({
    section: 'closing', analysis: 'closing', label: 'amount -' + a,
    setting: -a,
    set: { 44: CLOSE_FROM, 23: (256 - a) & 0xFF },
    why: 'whether the depth is symmetric about zero'
  });
});

/*
 * 4. The filter's release, held open and then let go.
 *
 * The envelope sits at full for a second, so the cutoff is steady and known, and then the
 * key comes up and the filter falls back to the keygroup's own setting. The amplitude
 * release is long enough for the note still to be sounding while that happens - without it
 * there would be nothing left to measure the filter on.
 */
RELEASES.forEach(function (r) {
  test({
    section: 'release', analysis: 'release', label: 'release ' + r,
    setting: r,
    hold: TIMING.releaseHold,
    /*
     * Based high on purpose, and shallow.
     *
     * The other sections hold a corner still and can take as long a window as they like to
     * find it. A release has to be FOLLOWED, in windows of a twelfth of a second, and a
     * window that short cannot resolve a corner near the 311 Hz floor - the bands down
     * there have barely a handful of cycles in it. Sweeping from the floor, which is what
     * the opening tests do, made every release read the same wrong answer.
     *
     * From stored 50 with an amount of 15 the cutoff runs 9.1 kHz down to 1.9 kHz. Two and
     * a quarter octaves, all of it high enough to read in a short window, and the levelling
     * band at 80-150 Hz is a long way below the bottom of it.
     *
     * The amplitude release is long - a stored 80 is nearly four seconds - because the
     * filter can only be measured while there is still a note to measure it on. What
     * actually ends these clips is the sample running out two seconds after the key.
     */
    set: { 44: RELEASE_FROM, 23: 15, 37: r, 6: 80 },
    why: 'how long the filter takes to fall back'
  });
});

// ------------------------------------------------------------------- the schedule

/** Every note, with when it starts, when it is let go, and what it is for. */
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

/** The keygroups ENVCAL needs, one per test, in the order the disk should hold them. */
function keygroups() {
  return TESTS.map(function (c) {
    return { low: c.key, high: c.key, set: c.set, why: c.why, sample: 'NOISE' };
  });
}

function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE,
  AMOUNTS: AMOUNTS, RELEASES: RELEASES,
  OPEN_FROM: OPEN_FROM, CLOSE_FROM: CLOSE_FROM, RELEASE_FROM: RELEASE_FROM,
  schedule: schedule, keygroups: keygroups, clips: clips
};
