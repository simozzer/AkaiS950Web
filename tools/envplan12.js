/*
 * The twelfth run: the two things run 11 could not separate.
 *
 *   node envdisk.js  build ENVCAL12           --plan envplan12.js
 *   node envmidi.js  AkaiEnvCalibration12.mid --plan envplan12.js
 *   node envcal.js   take.wav ENVCAL12.img    --plan envplan12.js
 *
 * WHERE WARP STANDS
 *
 * A pitch bend at note-on, decaying back to the nominal pitch. Byte 13 is the depth at
 * 6.43 cents a unit, linear, and the signs mirror. Byte 12 scales that depth with velocity.
 * Byte 14 sets the time constant, on a curve all of its own. There is no key follow: two
 * octaves apart the decay is the same to three digits.
 *
 *     depth in cents = 6.43 * byte13 * scale,  decaying with tau(byte14)
 *     scale = 1                               when byte 12 is 0
 *           = (byte12/99) * (velocity/127)    when byte 12 is above 0
 *
 * That fits all fifteen of run 11's clips to within 9%. Two gaps are left, and this run is
 * nothing but those two.
 *
 * A. WHAT BYTE 12 = 0 MEANS, WHICH RUN 11 MEASURED AT ONE VELOCITY
 *
 * Every byte-12 clip in run 11 was struck at velocity 127 - and at full velocity the two
 * readings of "0" predict exactly the same thing:
 *
 *     byte 12 = 0  meaning "no velocity sensitivity, always full depth"   -> full at vel 127
 *     byte 12 = 0  behaving like 99, the depth scaled by velocity          -> full at vel 127
 *
 * They only come apart when the key is played softly, and no clip did. This section is the
 * same keygroup struck at four velocities: a flat line across them means the first reading,
 * a depth that falls with velocity means the second.
 *
 * It decides how 22 real keygroups behave - the ones that set byte 13 with byte 12 left at 0.
 * Under one reading they bend fully however gently they are played; under the other they do
 * not bend at all below a hard strike. There is no splitting the difference between those.
 *
 * B. THE TIME CURVE WHERE IT BENDS HARDEST
 *
 * Five points measured: 30.5 ms at byte 0, 40.5 at 20, 63.8 at 50, 150.2 at 80, 743.9 at 99.
 * The bottom half is nearly flat and the top is not - the last nineteen bytes multiply the
 * time by five, and there is nothing measured inside that stretch at all. Interpolating a
 * table through a gap where the curve turns over is how the envelope table came to be 20%
 * wrong around stored 45, which is still an open fault in this repository.
 *
 * So: 90 and 95 where it matters most, 60 and 70 across the other bend, 30 and 40 to firm up
 * the flat part - and 99 again, because run 11 held its note for three seconds against a time
 * constant of 744 ms and read the settled pitch off a stretch that was still moving. Four
 * seconds here, which is 5.4 time constants rather than 4.0.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

var TONE_HZ = 1000;
var LOOPING = true;
var SAMPLES = [{ name: 'TONE', kind: 'tone', hz: TONE_HZ }];

/// As run 11. The LFO especially: it modulates the one quantity being measured.
var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  12: 99, 13: (-50) & 0xFF, 14: 50,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,
  43: 0,
  44: 99, 45: 0
};

/*
 * FOUR SECONDS, AND THE REASON IS ONE CLIP
 *
 * Everything here would be comfortable in two seconds except byte 14 at 99, whose 744 ms time
 * constant needs the note to outlast it several times over - not for the bend, which is a
 * tenth of the way down by 1.7 s, but for the SETTLED PITCH the bend is measured against.
 * That reference is the median of the note's last third, so a note that is still drifting when
 * it ends quietly biases every cent in the clip.
 *
 * A uniform length rather than a long one only where it is needed: run 7 asked for two note
 * lengths in one plan and came back with every note the same length, and the lesson taken was
 * that a plan with two answers has a way to go wrong that a plan with one does not.
 */
var TIMING = {
  hold: 4.0,
  gap: 2.0,
  sectionGap: 3.0,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var KEYGROUPS = [];
var nextKey = 36;

function sweep(spec) {
  var key = nextKey++;
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(spec.set).forEach(function (k) { set[k] = spec.set[k]; });

  (spec.velocities || [127]).forEach(function (velocity) {
    TESTS.push({
      section: spec.section, analysis: 'pitch',
      label: spec.label + (spec.velocities && spec.velocities.length > 1
                             ? ' at velocity ' + velocity : ''),
      key: key, velocity: velocity, hold: TIMING.hold, gapAfter: TIMING.gap,
      setting: spec.setting, watch: 'pitch', why: spec.why
    });
  });

  KEYGROUPS.push({ low: key, high: key, set: set, why: spec.why, sample: 'TONE' });
  return key;
}

/*
 * A. Byte 12 at zero, across the velocity range.
 *
 * Four velocities rather than two, because if the depth DOES fall with velocity the shape of
 * the fall is worth having in the same run - it would mean byte 12 = 0 is simply byte 12 = 99
 * under another name, and the model loses a branch rather than gaining a measurement.
 */
sweep({
  section: 'b12 zero', label: 'b12 0 (b13 -50)', setting: 0,
  velocities: [1, 32, 64, 127],
  set: { 12: 0 },
  why: 'whether byte 12 = 0 means full depth always, or the same as 99'
});

/*
 * B. The time curve, filling the gaps.
 *
 * All at byte 12 = 99 and velocity 127, which run 11 established as full depth - the deepest
 * bend gives the longest run of points above the noise and so the best-conditioned fit.
 */
[30, 40, 60, 70, 90, 95, 99].forEach(function (t) {
  sweep({
    section: 'b14 ' + t, label: 'b14 ' + t, setting: t,
    set: { 14: t },
    why: t === 99 ? 'the library default, re-measured against a note long enough for it'
                  : 'filling the time curve where it turns over'
  });
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
      note: c.key, velocity: c.velocity, first: first, watch: c.watch,
      from: at, releasedAt: at + c.hold, hold: c.hold
    });

    at += c.hold;
  });

  return { events: events, clips: clips, seconds: at + TIMING.gap };
}

function keygroups() { return KEYGROUPS; }
function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, LOOPING: LOOPING, SAMPLES: SAMPLES,
  TONE_HZ: TONE_HZ,
  FROM: 99, OPEN_FROM: 99, CLOSE_FROM: 99, RELEASE_FROM: 99, AMOUNT: 0,
  schedule: schedule, keygroups: keygroups, clips: clips
};
