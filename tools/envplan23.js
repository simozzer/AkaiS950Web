/*
 * The twenty-third run: the attack below stored 30, and whether the envelope curve steps.
 *
 *   node envdisk.js  build ENVCAL23           --plan envplan23.js
 *   node envmidi.js  AkaiEnvCalibration23.mid --plan envplan23.js
 *   node envcal.js   take.wav ENVCAL23.img    --plan envplan23.js
 *
 *   A  THE VCA ATTACK BELOW STORED 30, measured directly. It has two points down there -
 *      stored 8 and 20 - and both were reached SIDEWAYS, through the velocity rule rather
 *      than by setting the byte. They inherit whatever that rule gets wrong, and everything
 *      between and below them is interpolation.
 *   B  DOES THE ENVELOPE CURVE STEP? Consecutive settings, one stored unit apart, read as
 *      release rates where the precision is about one per cent.
 *
 * WHY B IS THE FILTER-ATTACK QUESTION, ASKED WHERE IT CAN BE ANSWERED
 *
 * The open item was "the filter attack may quantise like the VCA's - 5.4/n for whole n -
 * but it was measured to about 5%, which is far too coarse to see 0.7% steps". That splits
 * into two questions and run 22 has already answered the first.
 *
 * Run 22 traced the filter's attack at six settings with three of run 21's decay settings
 * in the same take, and the two matched to 3%: 0.51 against 0.51, 0.82 against 0.82, 1.43
 * against 1.39. The filter's decay follows ENV_TIME. So the filter's attack follows
 * ENV_TIME too, and NOT the VCA attack's 5.4/n, which is a different curve entirely -
 * across stored 60 to 70 the two differ by 30%.
 *
 * What is left is whether ENV_TIME ITSELF steps, and that need not be measured on the
 * filter at all. A moving corner can be timed to about 5%; a falling level can be timed to
 * about 1%, which run 19 showed over sixteen clips. So the question goes to the VCA
 * release, where the answer will be legible - and the filter inherits it, because run 22
 * established they are one curve.
 *
 * WHY 45 TO 56
 *
 * Run 19 walked ENV_TIME in fives and found the steps uneven in a way no smooth curve
 * makes: ten units double the time, but the two fives inside each decade go x1.60 then
 * x1.34, four times each. 45 to 50 is one of the big steps and 50 to 55 one of the small
 * ones, so sampling every unit across 45 to 56 shows WHERE inside those blocks the time
 * actually moves. If it is a counter the jumps will sit at particular bytes with flat
 * stretches between; if it is a smooth curve every unit will move it by about seven per
 * cent, which is well clear of the one per cent the measurement can see.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

/*
 * Noise, and looped so a held note lasts as long as the attack ladder needs. Nothing here
 * finds a corner, so the one-shot rule that runs 20 to 22 needed does not apply - those
 * read the filter, and this reads levels.
 */
var SAMPLES = [
  { name: 'NOISE', kind: 'noise', frames: 132300, loopMode: 'L', loopLength: 132300 }
];

/*
 * A. The attack ladder.
 *
 * 8 and 20 are the two the table already has, so they say whether measuring the byte
 * directly agrees with reaching it through the velocity rule. 35 and 40 sit in the region
 * the table measured properly, and are the check that this method agrees with that one
 * where they overlap.
 *
 * The bottom is set by the measurement, not the machine. A rising level is fitted through
 * the gains between a tenth and nine tenths with windows a twenty-fifth of the ramp,
 * floored at 8 ms - so a ramp of 200 ms gets 25 points, one of 50 ms gets six, and one of
 * 20 ms gets two and cannot be fitted at all. Stored 8 is 20 ms by the current table and
 * is asked for anyway: it costs one note, and the analysis says plainly when there is too
 * little of a rise to read.
 */
var ATTACKS = [8, 10, 12, 15, 18, 20, 22, 25, 28, 30, 35, 40];

/*
 * B. Every unit from 45 to 56.
 *
 * Releases rather than attacks, because the release is a RATE - 42.5 dB in one envelope
 * time - so timing a fall reads ENV_TIME directly with no shape to unpick, and run 19
 * measured sixteen of them with worst-off-the-line residuals of 0.3 to 1.3 dB over a
 * 20 dB fit. That is the one per cent this needs.
 */
var RELEASES = [45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56];

var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
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
  hold: 1.2,
  gap: 0.8,          // the SHORTEST gap in the run - what the note splitter is tuned to
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
 * A. THE ATTACK, SET AS A BYTE RATHER THAN REACHED THROUGH VELOCITY.
 *
 * Attack under test, everything else out of the way: sustain full so the note holds at the
 * top of its rise, no decay, no release. Velocity to attack is zero - which is the whole
 * point, since the two readings this replaces were taken by setting a base of 70 and using
 * byte 9 to pull the effective value down to 8 and 20.
 */
var keyA = 24;
ATTACKS.forEach(function (a) {
  keygroup(keyA, keyA, { 3: a });
  note({ section: 'attack', analysis: 'level', label: 'attack ' + a,
         key: keyA, hold: 1.2, gapAfter: 0.8, setting: a, rising: true,
         why: a === 8 || a === 20 ? 'the table has this one already, reached through velocity'
            : a >= 35 ? 'inside the well-measured region - the check that the methods agree'
            : 'the gap: interpolated, never set directly' });
  keyA++;
});

/*
 * B. EVERY UNIT FROM 45 TO 56.
 *
 * Attack 0 and sustain 99, so the note is at full level from its first sample and the only
 * thing to time is the fall after the key comes up.
 *
 * 1.4 s of gap: the slowest here, stored 56, falls 42.5 dB in about 0.44 s and reaches the
 * noise floor in 0.8. The fit only wants the first 20 dB, but a gap that ends while the
 * note is still audible leaves the splitter hunting for the next onset inside a tail.
 *
 * The section is called "release" exactly - that is what tells the level analysis to trace
 * from the key coming UP rather than from the strike.
 */
var keyB = 40;
RELEASES.forEach(function (r) {
  keygroup(keyB, keyB, { 6: r });
  note({ section: 'release', analysis: 'level', label: 'release ' + r,
         key: keyB, hold: 0.8, gapAfter: 1.4, setting: r,
         why: 'one unit at a time, to see whether the curve steps or glides' });
  keyB++;
});

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

  return { events: events, clips: clips, seconds: at + 2.0 };
}

function keygroups() { return KEYGROUPS; }
function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, LOOPING: true, SAMPLES: SAMPLES,
  ATTACKS: ATTACKS, RELEASES: RELEASES,
  FROM: 99, OPEN_FROM: 99, CLOSE_FROM: 99, RELEASE_FROM: 99, AMOUNT: 0,
  schedule: schedule, keygroups: keygroups, clips: clips
};
