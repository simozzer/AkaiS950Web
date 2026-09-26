/*
 * The ninth run: the SHAPE of velocity to release.
 *
 *   node envdisk.js  build ENVCAL9           --plan envplan9.js
 *   node envmidi.js  AkaiEnvCalibration9.mid --plan envplan9.js
 *   node envcal.js   take.wav ENVCAL9.img    --plan envplan9.js
 *
 * WHAT RUN 8 ESTABLISHED, AND WHAT IT COULD NOT
 *
 * Keygroup byte 10 is a velocity depth on the release, and bit 0x10 of the flags byte - the
 * ON/OFF sitting next to Release on the velocity page - is what enables it. Run 8 set that bit
 * and replayed run 7's sequence, and the difference was not subtle. Time from key-up to 40 dB
 * down:
 *
 *     byte 10    vel 1 off   vel 127 off   vel 1 ON    vel 127 ON
 *       -50       11073 ms     10931 ms    11075 ms      instant
 *       +50          25 ms        27 ms       26 ms     11079 ms
 *         0        1333 ms      1304 ms     1304 ms      1322 ms
 *
 * So the sign of the byte reverses which end of the keyboard gets the long release, depth 0 is
 * inert, and with the switch OFF every velocity behaves exactly as velocity 1 does with it on.
 *
 * What it could not give is the shape. At ±50 both ends saturate - one against the fastest
 * release the machine has, the other against the byte-99 clamp - so five of the six clips only
 * said "as far as it goes in this direction". A pivot could sit anywhere between them.
 *
 * THIS RUN IS SIZED SO THAT NOTHING CLIPS
 *
 * With a base release of 70 the effective byte has 29 units of room either way before it hits
 * 0 or 99. Depth 25 uses almost all of it and nothing saturates; depth 12 is half that, which
 * is the only way to ask whether the depth byte scales the effect in a straight line - a
 * question every other velocity depth in the model assumes the answer to and none has measured.
 *
 * WHAT HAS TO BE ESTABLISHED
 *
 *   THE PIVOT    Velocity to FILTER turns about 65. Velocity to ATTACK turns about nothing -
 *                velocity 1 leaves the byte alone and it only ever shortens. Those are the two
 *                shapes on offer and this parameter could be either, so five velocities across
 *                the range rather than the two that only prove a difference exists.
 *   THE SHAPE    Straight in velocity, or straight in the log, or something with a knee. Five
 *                points on two mirrored depths is enough to tell those apart.
 *   THE SIGN     +25 and -25 should mirror each other exactly about the pivot. If they do not,
 *                the sign is doing something other than negating the depth.
 *   THE DEPTH    Whether 12 gives half of what 25 gives.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

/*
 * THE BIT THE WHOLE RUN DEPENDS ON.
 *
 * Run 7 measured this parameter with its own enable switched off and read a flat line for its
 * trouble. Every keygroup here sets it.
 */
var FLAG_VELOCITY_RELEASE = 0x10;

var LOOPING = true;

/*
 * Nothing but the release may move.
 *
 * The attack is 0 so the note is at full level the instant it starts, the sustain is 99 so it
 * stays there, and the decay never gets a chance to run. Bytes 7, 9 and 11 are zero so neither
 * the filter, the attack nor the loudness follows the strike - otherwise a velocity sweep would
 * change the level the release is measured down from, which is the one thing that would quietly
 * corrupt every number in the run.
 */
var BASE = {
  3: 0, 4: 0, 5: 99, 6: 70,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC | FLAG_VELOCITY_RELEASE,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,
  43: 0,
  44: 99, 45: 0
};

var RELEASE_BASE = 70;

/*
 * TWO SECONDS OF NOTE, BECAUSE THERE IS NOTHING TO WAIT FOR
 *
 * Run 7 held these for five. With an attack of 0 and a sustain of 99 the note is flat at full
 * level from the first sample, so a hold only has to be long enough to be sure of that and to
 * give the analysis a plateau to measure the fall against. Two seconds is both, and the three
 * seconds saved on every clip is what pays for five velocities instead of two.
 *
 * THE GAP IS SIZED PER CLIP, FROM A PREDICTION
 *
 * A gap has to outlast the release, and these releases differ by a factor of thirty across the
 * run. One gap for all of them means every fast clip waits for the slowest, which is how run 7
 * came to be 254 seconds and how it came to be stopped early twice.
 *
 * So gapFor() predicts the effective byte from the hypothesis this run exists to test, and
 * allows generously against it. Being wrong about the shape costs a clip that runs into the
 * next one - recoverable, and obvious in the analysis - rather than a wrong number.
 */
var TIMING = {
  hold: 2.0,
  gap: 4.0,
  sectionGap: 4.0,
  lead: 1.0,
  channel: 0
};

/*
 * The hypothesis, used ONLY to size gaps - never to interpret a result.
 *
 * Run 8 pins the two ends: at velocity 1 the effective byte is release - depth, and at velocity
 * 127 it is release + depth. A straight line between them pivots at 64. If the real pivot is
 * somewhere else the gaps are merely mis-sized, and the numbers the run produces are what
 * decide the matter.
 */
function predictedByte(depth, velocity) {
  var g = (64 - velocity) / 63;                 // +1 at velocity 1, -1 at velocity 127
  var b = RELEASE_BASE - depth * g;
  return b < 0 ? 0 : b > 99 ? 99 : b;
}

/*
 * Seconds of silence to leave after a note, from the release the byte implies.
 *
 * The envelope curve says stored 95 is about 8 s and stored 99 about 10.7, and a fall is not
 * over when it reaches 40 dB down - the tail keeps going. These are roughly three times the
 * time-to-40 dB that the curve predicts, which is what run 7 showed was needed for the splitter
 * to find silence on either side of a clip.
 */
function gapFor(depth, velocity) {
  var b = predictedByte(depth, velocity);
  if (b >= 90) return 24.0;
  if (b >= 80) return 14.0;
  if (b >= 70) return 8.0;
  if (b >= 60) return 5.0;
  return 3.0;
}

var TESTS = [];
var KEYGROUPS = [];
var nextKey = 36;

/// One keygroup per depth, struck at a list of velocities - as in runs 6 and 7.
function sweep(spec) {
  var key = nextKey++;
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  set[10] = spec.depth & 0xFF;                  // signed, stored as a byte

  spec.velocities.forEach(function (velocity) {
    TESTS.push({
      section: spec.section,
      analysis: 'level',
      label: spec.label + ' at velocity ' + velocity,
      key: key, velocity: velocity,
      hold: TIMING.hold,
      gapAfter: gapFor(spec.depth, velocity),
      setting: velocity, rising: false, watch: 'level', why: spec.why
    });
  });

  KEYGROUPS.push({ low: key, high: key, set: set, why: spec.why, sample: 'NOISE' });
}

/*
 * 1 and 2. The two signs at the depth that uses the whole range without clipping.
 *
 * Five velocities apiece. These are the run: the pivot, the shape and whether the sign simply
 * mirrors all come out of these ten clips.
 */
[25, -25].forEach(function (depth) {
  sweep({
    section: 'release ' + (depth > 0 ? '+' : '') + depth,
    label: 'vel->release ' + (depth > 0 ? '+' : '') + depth,
    depth: depth,
    velocities: [1, 32, 64, 96, 127],
    why: 'the pivot and the shape, at a depth where neither end saturates'
  });
});

/*
 * 3 and 4. Half the depth, three velocities.
 *
 * Only the ends and the middle, because the shape is section 1's job and this one asks a
 * narrower question: does 12 move the release half as far as 25 does? Every velocity depth in
 * the model divides the byte by 99 and calls it linear, and not one of them was measured.
 */
[12, -12].forEach(function (depth) {
  sweep({
    section: 'release ' + (depth > 0 ? '+' : '') + depth,
    label: 'vel->release ' + (depth > 0 ? '+' : '') + depth,
    depth: depth,
    velocities: [1, 64, 127],
    why: 'whether the depth byte scales the effect in a straight line'
  });
});

/*
 * 5. The control, and the run rests on it.
 *
 * Depth 0 with the enable bit still SET. If these two clips differ from each other then the
 * bit itself changes the release, and every number above is measuring that rather than the
 * depth. Run 8 says they will not - 1304 ms against 1322 - but that was a different disk.
 */
sweep({
  section: 'release 0',
  label: 'vel->release 0',
  depth: 0,
  velocities: [1, 127],
  why: 'the control: with no depth, velocity must change nothing even with the bit set'
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
      from: at, releasedAt: at + c.hold, hold: c.hold
    });

    at += c.hold;
  });

  return { events: events, clips: clips, seconds: at + (previous ? previous.gapAfter : 4) };
}

function keygroups() { return KEYGROUPS; }
function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, LOOPING: LOOPING,
  RELEASE_BASE: RELEASE_BASE,
  predictedByte: predictedByte,
  FROM: 99, OPEN_FROM: 99, CLOSE_FROM: 99, RELEASE_FROM: 99, AMOUNT: 0,
  schedule: schedule, keygroups: keygroups, clips: clips
};
