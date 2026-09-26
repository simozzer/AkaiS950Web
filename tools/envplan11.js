/*
 * The eleventh run: WARP, now that we know which byte bends the pitch.
 *
 *   node envdisk.js  build ENVCAL11           --plan envplan11.js
 *   node envmidi.js  AkaiEnvCalibration11.mid --plan envplan11.js
 *   node envcal.js   take.wav ENVCAL11.img    --plan envplan11.js
 *
 * WHAT RUN 10 SETTLED
 *
 * Warp is a pitch envelope: a bend at note-on decaying back to the nominal pitch. With bytes
 * 12/13/14 at 99/-50/50 the note starts about three semitones flat and comes back with a time
 * constant of 67 ms; at 99/+50/50 it starts three semitones sharp instead.
 *
 * And there is NO KEY FOLLOW. The same keygroup struck at keys 48, 60 and 72 - two octaves -
 * gave time constants of 67.2, 67.4 and 67.4 ms and depths of 314, 314 and 316 cents. Nothing
 * about the bend tracks the note played. Both published descriptions of Warp say byte 13 is a
 * key follow that shortens the decay as notes rise; it is not, and the panel's name for it -
 * ATTACK OFFSET - survives where theirs does not.
 *
 * WHAT RUN 10 GOT WRONG, WHICH IS WHY THIS RUN EXISTS
 *
 * It swept bytes 12 and 14 with byte 13 sitting at ZERO, because the panel calls byte 12
 * "warp velocity" and that was taken to mean it was the depth. Byte 13 is the depth. So the
 * whole of that sweep measured a bend whose depth was set to nothing, read flat, and said
 * nothing about either byte.
 *
 * Worse, it cannot even show byte 13 is sufficient on its own: every clip that bent had byte
 * 12 at 99 as well. Byte 12 might be a gate, a scale, or genuinely nothing, and run 10 cannot
 * tell those apart - so section A here is the first thing asked and the rest of the run is
 * conditional on it.
 *
 * WHAT HAS TO BE ESTABLISHED
 *
 *   A  IS 12 A GATE   Byte 13 held at -50 while byte 12 goes 0, 25, 50, 99. If 0 still bends,
 *                     byte 12 is not required; if the depth tracks it, it is a scale; if only
 *                     99 bends, it is a switch. One of those three, and nothing else in this
 *                     run means much until it is known.
 *   B  DEPTH          Byte 13 at -12, -25, +25, +50 against the known -50. Whether the bend
 *                     is linear in the byte, and whether the two signs mirror - run 10 read
 *                     314 cents down against 287 up, which is either a real asymmetry or the
 *                     measurement, and four more points will say which.
 *   C  TIME           Byte 14 at 0, 20, 80, 99 against the known 50. Whether it sets the 67 ms
 *                     at all, and which way it runs. 99 is the value 1529 of the 1908 real
 *                     keygroups carry, so whatever 99 means is what most disks actually do.
 *   D  VELOCITY       The same keygroup at velocities 1, 64 and 127. Byte 12 is called "warp
 *                     velocity" and byte 9 turned out to mean its name while byte 10 needed a
 *                     switch nobody knew about - so the name is a hypothesis, not a fact.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

var TONE_HZ = 1000;
var LOOPING = true;
var SAMPLES = [{ name: 'TONE', kind: 'tone', hz: TONE_HZ }];

/*
 * Nothing but the pitch may move, and the LFO least of all - it modulates pitch, which is the
 * quantity being measured. Depth, rate and delay zero, desync set. The amplitude is flat from
 * the first sample: attack 0, sustain 99, no decay, no release.
 *
 * Constant pitch is ON throughout. Run 10 already answered the key-follow question outright,
 * so every note here can sound at the same 1000 Hz, which is the easiest thing to track and
 * lets all fourteen clips be compared without a per-clip reference pitch.
 */
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
 * THREE SECONDS OF NOTE FOR AN EVENT THAT LASTS A THIRD OF ONE
 *
 * The bend is done in about 300 ms at byte 14 = 50. The note is ten times that, and almost all
 * of it is there to give the analysis a long settled stretch to measure the bend against -
 * every depth in this run is quoted in cents relative to where its own note ends up.
 *
 * The exception is byte 14 = 99, which is the one setting that could be far slower than
 * anything seen. If the time byte runs the way the count in the library suggests, 99 is the
 * common case and could stretch the bend well past 300 ms. Three seconds covers a bend forty
 * times slower than the one measured; if even that is not enough the trace will still be
 * falling when the note ends, and the analysis will say so rather than report a depth.
 */
var TIMING = {
  hold: 3.0,
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
 * A. Is byte 12 a gate, a scale, or nothing?
 *
 * The depth byte is held at the value run 10 measured, and byte 12 swept beneath it. This is
 * first because the answer decides how to read every other section: if byte 12 turns out to
 * scale the depth, then sections B and C are measuring at full scale and say so, and if it
 * gates then a zero anywhere else in the run would have produced a silent flat trace.
 */
[0, 25, 50, 99].forEach(function (v) {
  sweep({
    section: 'byte12 ' + v, label: 'b12 ' + v + ' (b13 -50)', setting: v,
    set: { 12: v },
    why: 'whether byte 12 gates the bend, scales it, or does nothing'
  });
});

/*
 * B. The depth byte, at both signs.
 *
 * -50 is section A's last clip, so it is not repeated here; these four fill in around it.
 */
[-25, -12, 25, 50].forEach(function (d) {
  sweep({
    section: 'byte13 ' + (d > 0 ? '+' : '') + d,
    label: 'b13 ' + (d > 0 ? '+' : '') + d, setting: d,
    set: { 13: d & 0xFF },
    why: 'whether the bend is linear in the depth byte, and whether the signs mirror'
  });
});

/*
 * C. The time byte.
 *
 * 0 and 99 are both ends, 20 and 80 fill in. 50 is section A's last clip again.
 */
[0, 20, 80, 99].forEach(function (t) {
  sweep({
    section: 'byte14 ' + t, label: 'b14 ' + t, setting: t,
    set: { 14: t },
    why: 'whether byte 14 sets the 67 ms, and which way the byte runs'
  });
});

/*
 * D. Does the bend follow the strike?
 *
 * Its own keygroup rather than a second visit to section A's, so the three velocities sit
 * together in the take and share a splitter section.
 */
sweep({
  section: 'velocity', label: 'b13 -50', setting: 0,
  velocities: [1, 64, 127],
  set: {},
  why: 'whether a soft strike bends less, which the name "warp velocity" begs'
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
