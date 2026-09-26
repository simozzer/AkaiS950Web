/*
 * The tenth run: WARP - and first of all, whether it does anything.
 *
 *   node envdisk.js  build ENVCAL10           --plan envplan10.js
 *   node envmidi.js  AkaiEnvCalibration10.mid --plan envplan10.js
 *   node envcal.js   take.wav ENVCAL10.img    --plan envplan10.js
 *
 * Keygroup bytes 12, 13 and 14. The bytes were pinned down from the panel long ago and the
 * list tool reads them; no engine carries them and nothing has ever measured what they do.
 * 98 of the 1908 keygroups on the real disks turn warp on, across 14 programmes on 7 disks -
 * mostly drums and percussion, plus SAX and two RECORDERs.
 *
 * WHY THIS RUN LOOKS DIFFERENT FROM THE OTHERS
 *
 * Every run so far has measured amplitude or brightness, because every parameter so far moved
 * one or the other. Two descriptions of Warp agree it is a PITCH envelope - a bend at the
 * start of the note, decaying back to the nominal pitch - so this one tracks frequency, which
 * is a mode the analysis did not have before this run.
 *
 * That hypothesis is the reason for the design and is NOT an assumption the run depends on.
 * Section A asks whether the pitch moves at all before anything else is worth asking, and a
 * flat trace there is a complete answer: it would say Warp is not a pitch envelope, and the
 * next run would go looking at amplitude and brightness instead.
 *
 * WHAT THE DESCRIPTIONS GET WRONG, AND WHY THE RUN DOES NOT FOLLOW THEM
 *
 * Both accounts call byte 12 a bipolar depth - positive bending down to the note, negative
 * bending up. The disks say otherwise: across 1908 keygroups byte 12 never exceeds 99 and is
 * never negative, while byte 13 has 81 negative values. The bipolar control is 13, not 12. An
 * account that has the polarity on the wrong byte is not a safe guide to the rest, so nothing
 * here is sized to fit it.
 *
 * They also disagree with the panel on what byte 13 is. The panel and the disk-format notes
 * call it ATTACK OFFSET; both AI descriptions call it KEY FOLLOW. Those imply different
 * mechanisms - one anchored to the envelope, one to the keyboard - and section E separates
 * them outright, because key follow changes with the note played and an attack offset does
 * not. It is built in from the start rather than left for a later run, since it is the one
 * point the two stories actually conflict on and no amount of reading settles it.
 *
 * WHAT HAS TO BE ESTABLISHED, IN THIS ORDER
 *
 *   A  DOES IT MOVE      Warp full on against warp off, same note, same everything else. If
 *                        the pitch traces lie on top of each other, stop.
 *   B  HOW FAR           Byte 12 at 25, 50 and 99 - the depth, and whether it scales.
 *   C  HOW LONG          Byte 14 at 20, 50 and 80 - the time, and which way round it runs.
 *   D  VELOCITY          Byte 12 is called "warp velocity". Whether a soft strike bends less
 *                        is a question the name begs and only a measurement answers - byte 9
 *                        is called velocity-to-attack and turned out to mean it; byte 10 is
 *                        called velocity-to-release and needed a switch nobody knew about.
 *   E  13 IS WHICH       The same keygroup struck at three pitches two octaves apart. If the
 *                        bend's duration tracks the key, byte 13 is key follow. If it does
 *                        not, the panel is right and it is an attack offset.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

/// A sine, so the pitch can be read off it. Looped, so the note lasts as long as it is held.
var TONE_HZ = 1000;
var LOOPING = true;

var SAMPLES = [{ name: 'TONE', kind: 'tone', hz: TONE_HZ }];

/*
 * Nothing but the pitch may move.
 *
 * The LFO matters more here than in any run so far: it modulates PITCH, which is the one thing
 * being measured, so depth, rate and delay are all zero and desync is set. The amplitude
 * envelope is flat - attack 0, sustain 99, no decay, no release - so the note is at full level
 * from the first sample to the last and nothing about the level can be mistaken for a bend.
 * The filter is wide open and static.
 */
var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  12: 0, 13: 0, 14: 0,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,
  43: 0,
  44: 99, 45: 0
};

/*
 * WARP TIME 50 AS THE MIDDLE, BECAUSE NOBODY KNOWS WHICH WAY IT RUNS
 *
 * Byte 14 reads 99 in 1529 of the 1908 real keygroups, which makes 99 the default rather than
 * a setting - the same shape of clue as the modwheel's default of 50. Whether 99 is a long
 * bend or a short one is section C's job. Everything outside section C sits at 50 so that a
 * wrong guess about the direction costs half the range rather than all of it.
 */
var WARP_TIME = 50;

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

/// One keygroup at one key, struck at a list of velocities.
function sweep(spec) {
  var key = spec.key !== undefined ? spec.key : nextKey++;
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(spec.set).forEach(function (k) { set[k] = spec.set[k]; });

  (spec.velocities || [127]).forEach(function (velocity) {
    TESTS.push({
      section: spec.section, analysis: 'pitch',
      label: spec.label + (spec.velocities && spec.velocities.length > 1
                             ? ' at velocity ' + velocity : ''),
      key: key, velocity: velocity, hold: TIMING.hold, gapAfter: TIMING.gap,
      setting: velocity, watch: 'pitch', why: spec.why
    });
  });

  if (spec.reuse) return key;
  KEYGROUPS.push({ low: key, high: key, set: set, why: spec.why, sample: 'TONE' });
  return key;
}

/*
 * Sections A and B. Does it move, and how far.
 *
 * Warp off first - that clip is the reference every other trace in the run is read against,
 * because a sample played back through a sampler is not guaranteed to sit exactly on its
 * nominal pitch and what matters is the DIFFERENCE between warped and not.
 */
[0, 25, 50, 99].forEach(function (depth) {
  sweep({
    section: 'depth ' + depth,
    label: 'warp ' + depth,
    set: { 12: depth, 14: WARP_TIME },
    why: depth === 0 ? 'the reference: warp off, so any bend here is not warp'
                     : 'whether the pitch moves, which way, and how far'
  });
});

/*
 * Section C. The time byte, at full depth so the bend is as easy to see as it gets.
 */
[20, 80].forEach(function (time) {
  sweep({
    section: 'time ' + time,
    label: 'warp time ' + time,
    set: { 12: 99, 14: time },
    why: 'how long the bend lasts, and which way the byte runs'
  });
});

/*
 * Section D. Byte 13, at both signs.
 *
 * Whatever it is, it is the only bipolar control of the three and the library uses -50 in 51
 * keygroups, so the negative side is the one that matters most.
 */
[-50, 50].forEach(function (off) {
  sweep({
    section: 'byte13 ' + (off > 0 ? '+' : '') + off,
    label: 'warp b13 ' + (off > 0 ? '+' : '') + off,
    set: { 12: 99, 13: off & 0xFF, 14: WARP_TIME },
    why: 'what the signed byte does, at the value the library chose'
  });
});

/*
 * Section E. Does byte 12 follow the strike, as its name says?
 *
 * A separate keygroup rather than reusing the full-depth one, so that the velocity clips sit
 * together in the take and share a splitter section.
 */
sweep({
  section: 'velocity',
  label: 'warp 99 velocity',
  set: { 12: 99, 14: WARP_TIME },
  velocities: [1, 64, 127],
  why: 'whether a soft strike bends less, which the name "warp velocity" begs'
});

/*
 * Section F. Key follow or attack offset - the one point the two descriptions conflict on.
 *
 * ONE keygroup spanning two octaves, played at three keys, with CONSTANT PITCH OFF so the key
 * actually changes the playback rate. Byte 13 is set, because that is the control under test:
 * if its effect on the bend's duration changes with the note played, it is key follow, and if
 * the three traces are the same shape in time it is not.
 *
 * The bend is measured as a RATIO to each note's own settled pitch, so it does not matter that
 * the three notes sound at three different frequencies.
 */
(function () {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  set[12] = 99; set[13] = (-50) & 0xFF; set[14] = WARP_TIME;
  set[18] = FLAG_DESYNC;                 // constant pitch OFF - the key must change the rate

  [48, 60, 72].forEach(function (key) {
    TESTS.push({
      section: 'key follow', analysis: 'pitch', label: 'warp b13 -50 at key ' + key,
      key: key, velocity: 127, hold: TIMING.hold, gapAfter: TIMING.gap,
      setting: key, watch: 'pitch',
      why: 'key follow changes with the note played; an attack offset does not'
    });
  });

  KEYGROUPS.push({ low: 48, high: 72, set: set, sample: 'TONE',
                   why: 'one keygroup across two octaves, to tell key follow from an offset' });
})();

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
  TONE_HZ: TONE_HZ, WARP_TIME: WARP_TIME,
  FROM: 99, OPEN_FROM: 99, CLOSE_FROM: 99, RELEASE_FROM: 99, AMOUNT: 0,
  schedule: schedule, keygroups: keygroups, clips: clips
};
