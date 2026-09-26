/*
 * The sixteenth run: the crossfade's shape, where run 15 could not pin it.
 *
 *   node envdisk.js  build ENVCAL16           --plan envplan16.js
 *   node envmidi.js  AkaiEnvCalibration16.mid --plan envplan16.js
 *   node envcal.js   take.wav ENVCAL16.img    --plan envplan16.js
 *
 * WHAT RUN 15 SETTLED, AND THE ONE THING IT DID NOT
 *
 * Two keygroups sharing a stretch of keyboard are faded into one another, symmetrically, and
 * two keygroups covering exactly the SAME keys are not faded at all - they sit at a constant
 * -3.7 dB apiece however high or low you play, so the ARP2600 layers are safe and the obvious
 * rule that would have silenced them is wrong.
 *
 * What it could not pin is the curve. Measured at a seven-key overlap and a thirteen-key one:
 *
 *     fraction across    0     1/6    1/3    1/2    2/3    5/6     1
 *     seven keys      -0.1   -1.0   -2.2   -4.2   -7.4  -11.3  -19.4
 *     thirteen        -0.0   -0.4   -2.0   -4.2   -7.7  -15.0  -26.0
 *
 * They agree through the middle third and part at the edges - 3.7 dB apart at five sixths,
 * far above any measurement floor. And the midpoint is -4.2 dB where equal power would be
 * -3.0 and a linear amplitude fade -6.0, so it is neither, and the pair together dip 1.2 dB
 * rather than holding level. No standard crossfade does that.
 *
 * A table could be fitted to those two curves and would be a large improvement on what the
 * engines do now, which is to sound both keygroups at full level. But it would be fitted
 * through exactly the region where the two measurements disagree, and this project has been
 * caught by that before: the envelope curve is still 20% wrong around stored 45 because it
 * was interpolated across a gap where nothing had been measured.
 *
 * WHAT THIS RUN ADDS
 *
 *   FOUR WIDTHS      1, 3, 7 and 25 keys. If the shape is a function of position-as-a-
 *                    fraction then all four fall on one curve; if it is not, four points of
 *                    disagreement say far more about what it really depends on than two do.
 *                    The seven-key case repeats run 15's exactly, which also says whether
 *                    the whole thing reproduces across two sessions and two disks.
 *   EVERY KEY        At widths 1, 3 and 7 every key in the overlap is played, and at 25 the
 *                    first four and last four are - which is where run 15's two curves came
 *                    apart and where it sampled most thinly.
 *   A SINGLE KEY     Width 1 is the degenerate case and the library has 13 pairs of it. One
 *                    shared key cannot be a quarter or three quarters of the way across an
 *                    overlap, so whatever happens there is a fact about the mechanism rather
 *                    than about the shape - does it fade at all, and to what?
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

/// As run 15. Not harmonically related, so no tone's harmonics land in another's bin.
var TONES = [1000, 2200];

var SAMPLES = [
  { name: 'T1', kind: 'tone', hz: TONES[0], frames: 4410, loopMode: 'L', loopLength: 4410 },
  { name: 'T2', kind: 'tone', hz: TONES[1], frames: 4410, loopMode: 'L', loopLength: 4410 }
];

/// Byte 21 of the programme header: the crossfade, on.
var HEADER = { 21: 255 };

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
  hold: 1.5,
  gap: 1.0,
  sectionGap: 2.0,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var KEYGROUPS = [];

function keygroup(low, high, sample) {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  set[0] = high; set[1] = low;
  KEYGROUPS.push({ low: low, high: high, set: set, sample: sample,
                   why: sample + ' over keys ' + low + ' to ' + high });
}

function play(section, keys, why) {
  keys.forEach(function (key) {
    TESTS.push({
      section: section, analysis: 'mix', label: section + ', key ' + key,
      key: key, velocity: 127, hold: TIMING.hold, gapAfter: TIMING.gap,
      setting: key, watch: 'mix', why: why
    });
  });
}

/*
 * The four overlaps, kept well apart from one another.
 *
 * Every section needs keys either side where one keygroup sounds alone - that is what each
 * tone's full level is read from, and it is why the sections cannot be allowed to touch. The
 * gaps between them, 36-40 and 46-50 and 60-64, are deliberate empty ground.
 */

/* Width 1: keys 24-30 against 30-36, sharing exactly key 30. */
keygroup(24, 30, 'T1');
keygroup(30, 36, 'T2');
play('width 1', [27, 30, 33],
     'one shared key - does it fade at all, and to what?');

/* Width 3: 40-44 against 42-46, sharing 42 to 44. Every key of it. */
keygroup(40, 44, 'T1');
keygroup(42, 46, 'T2');
play('width 3', [40, 42, 43, 44, 46],
     'the narrowest overlap that has a middle');

/* Width 7: 50-58 against 52-60, sharing 52 to 58. Run 15's case, repeated. */
keygroup(50, 58, 'T1');
keygroup(52, 60, 'T2');
play('width 7', [50, 52, 53, 54, 55, 56, 57, 58, 60],
     'run 15 again, on another disk in another session');

/*
 * Width 25: 64-92 against 68-96, sharing 68 to 92.
 *
 * Every key for the first four and the last four, because that is where run 15's two curves
 * parted and where it had only one sample apiece. The middle is enough to place the curve.
 */
keygroup(64, 92, 'T1');
keygroup(68, 96, 'T2');
play('width 25', [64, 66, 68, 69, 70, 71, 74, 80, 86, 89, 90, 91, 92, 94, 96],
     'the widest overlap, sampled densely at both ends');

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
      note: c.key, velocity: c.velocity, first: first, watch: c.watch,
      from: at, releasedAt: at + c.hold, hold: c.hold
    });

    at += c.hold;
  });

  return { events: events, clips: clips, seconds: at + TIMING.gap };
}

/// Where each played key sits in its own overlap, for reading the results against.
function overlaps() {
  return [
    { section: 'width 1',  from: 30, to: 30 },
    { section: 'width 3',  from: 42, to: 44 },
    { section: 'width 7',  from: 52, to: 58 },
    { section: 'width 25', from: 68, to: 92 }
  ];
}

function keygroups() { return KEYGROUPS; }
function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, HEADER: HEADER, LOOPING: true, SAMPLES: SAMPLES,
  TONES: TONES, overlaps: overlaps,
  FROM: 99, OPEN_FROM: 99, CLOSE_FROM: 99, RELEASE_FROM: 99, AMOUNT: 0,
  schedule: schedule, keygroups: keygroups, clips: clips
};
