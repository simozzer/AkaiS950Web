/*
 * The sixth run: where the velocity switch actually falls.
 *
 *   node envdisk.js  build ENVCAL6           --plan envplan6.js
 *   node envmidi.js  AkaiEnvCalibration6.mid --plan envplan6.js
 *   node envcal.js   take.wav ENVCAL6.img    --plan envplan6.js
 *
 * A keygroup holds two samples, a soft one and a hard one, and byte 2 says which velocity
 * hands over from the first to the second. All three implementations of this instrument read
 * that byte the same way:
 *
 *     zone 1   velocity  0 .. switch-1
 *     zone 2   velocity  switch .. 127
 *
 * and not one of those numbers has ever been measured. Two things could be wrong together:
 *
 *   THE BOUNDARY   A switch of 90 might mean 90 is the first velocity to reach the hard
 *                  sample, or the last to reach the soft one. The editor clamps the byte to
 *                  1..128, which hints the panel counts from one - and if it does, all three
 *                  are out by a velocity step in the same direction, which is exactly the
 *                  kind of error that stays invisible because everything agrees.
 *
 *   THE HANDOVER   We assume it is a switch. If the machine crossfades over a few velocities
 *                  instead, then every two-zone programme has a blend we are replacing with
 *                  a seam, and the seam is in the wrong place as well.
 *
 * WHY THIS RUN IS FORTY SECONDS AND NOT FIVE MINUTES
 *
 * Every run so far measured something that takes time to happen - a sweep, a decay, a release
 * - so its notes had to outlast the thing being measured and its gaps had to outlast the tail.
 * This one asks only WHICH SAMPLE SOUNDED, which is answered by a fraction of a second of
 * audio, and nothing here has a tail at all: the amplitude release is 0, so a note stops when
 * the key does.
 *
 * So the notes are 0.6 s and the gaps 0.6 s. The floor is the splitter's, not the machine's:
 * it discards any run of sound shorter than 250 ms and works in 10 ms frames, so 0.6 s of
 * note is well clear and 0.6 s of silence splits cleanly. Thirty-two notes fit in about forty
 * seconds.
 *
 * WHY A SINE AND NOISE
 *
 * Two pieces of noise sound alike, which is fine when the question is what a filter did to
 * one of them and useless when the question is which of two you are hearing. A 1 kHz sine
 * against white noise is the easiest pair there is - one has all its energy in a single bin,
 * the other has almost none in any - so telling them apart needs no threshold anyone has to
 * argue about, and a CROSSFADE shows up as a reading between the two rather than at either.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

/// Looped, so a note lasts as long as it is held rather than stopping at the sample's end.
var LOOPING = true;

/// The two samples. SOFT is the sine, HARD the noise, and the analysis tells them apart by
/// how much of the clip's energy sits at TONE_HZ.
var TONE_HZ = 1000;

var SAMPLES = [
  { name: 'SOFT', kind: 'tone', hz: TONE_HZ },
  { name: 'HARD', kind: 'noise' }
];

/*
 * Nothing but the sample may differ between one clip and the next.
 *
 * Velocity reaches the filter and the loudness on this machine, and both are switched off
 * here - byte 7 and byte 11 at 0 - because a run that sweeps velocity would otherwise change
 * the brightness and the level of every clip as it went, and a quiet clip is a clip the
 * splitter may not find. The filter is wide open, the filter envelope has no depth, the LFO
 * is still, and the amplitude is a flat gate: instant on, full sustain, instant off.
 */
var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,
  43: 0,
  44: 99, 45: 0,
  // zone 2's own filter and loudness, so the hard sample is neither brighter nor louder
  66: 99, 67: 0
};

var TIMING = {
  hold: 0.6,
  gap: 0.6,
  sectionGap: 1.2,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var nextKey = 36;

/*
 * One keygroup, played at a list of velocities.
 *
 * Every previous run gave each clip its own keygroup, because each was asking about a
 * different setting. Here the setting under test IS the velocity, so a keygroup is played
 * many times over and the clips share it.
 */
function switchAt(velocitySwitch, velocities, why) {
  var key = nextKey++;

  velocities.forEach(function (velocity) {
    TESTS.push({
      section: 'switch ' + velocitySwitch,
      analysis: 'zone',
      label: 'switch ' + velocitySwitch + ' at velocity ' + velocity,
      key: key, velocity: velocity, hold: TIMING.hold,
      setting: velocity, velocitySwitch: velocitySwitch,
      why: why
    });
  });

  return {
    low: key, high: key,
    set: (function () {
      var s = {};
      Object.keys(BASE).forEach(function (k) { s[k] = BASE[k]; });
      s[2] = velocitySwitch;
      return s;
    })(),
    why: why, sample: 'SOFT', sample2: 'HARD'
  };
}

var KEYGROUPS = [];

/*
 * 1. A switch at 64, swept coarsely across the whole range and finely across the boundary.
 *
 * The fine steps answer the off-by-one: whichever of 63 and 64 first brings the noise in is
 * the answer, and there is no interpretation left to do. The coarse ones answer the other
 * question at the same time - if the machine crossfades, the clips between 48 and 80 come
 * back part sine and part noise instead of one or the other.
 */
KEYGROUPS.push (switchAt (64,
  [1, 16, 32, 48, 56, 60, 61, 62, 63, 64, 65, 66, 67, 68, 72, 80, 96, 112, 127],
  'the boundary to one velocity step, and whether there is a blend either side of it'));

/*
 * 2. The same question at 90, because one switch point proves a coincidence.
 *
 * If 64 came back reading one step low it could be an accident of that number. Two switch
 * points disagreeing with the model in the same direction is a rule.
 */
KEYGROUPS.push (switchAt (90, [86, 87, 88, 89, 90, 91, 92, 93, 94],
  'that whatever 64 says is a rule and not a coincidence'));

/*
 * 3. The ends of the range, where an off-by-one has nowhere to hide.
 *
 * At a switch of 1 the model leaves the soft sample exactly one velocity - 0, which a
 * keyboard cannot even send - so if the model is right, velocity 1 is already the hard
 * sample and the soft one is unreachable. At 127 the model gives the hard sample only the
 * very hardest strike. Both are the sort of edge a firmware writer rounds differently.
 */
KEYGROUPS.push (switchAt (1, [1, 2, 3],
  'whether a switch of 1 leaves the soft sample reachable at all'));

KEYGROUPS.push (switchAt (127, [125, 126, 127],
  'whether the hardest strike is the only one that reaches zone 2'));

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
      velocitySwitch: c.velocitySwitch, watch: 'zone',
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
