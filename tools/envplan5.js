/*
 * The fifth run: the amplitude attack, and what the release does from half depth.
 *
 *   node envdisk.js  build ENVCAL5           --plan envplan5.js
 *   node envmidi.js  AkaiEnvCalibration5.mid --plan envplan5.js
 *   node envcal.js   take.wav ENVCAL5.img    --plan envplan5.js
 *
 * WHAT RUN 4 SETTLED AND WHAT IT DID NOT
 *
 * Run 4 measured the envelope time curve at nine settings on the filter envelope, where a
 * moving cutoff can be watched all the way down a long note, and attack, decay and release
 * all agreed on it to within 7%. That curve is now in the engines.
 *
 * The VCA attack does not fit it. Two clips is all run 4 had, and they say:
 *
 *     stored 70   reaches full in 1.41 s      the shared curve says 1.40   agrees
 *     stored 85   reaches full in 1.95 s      the shared curve says 4.04   does not
 *
 * Fifteen units of the panel bought 1.4x where the shared curve wants 2.9x. Both readings
 * are solid - every point on each ramp gives the same answer to within 3% - so this is not
 * noise, and no single multiplier on the shared curve can produce it. AttackScale is
 * currently 1, which is right at 70 and twice too slow at 85, and it is the weakest number
 * in the model.
 *
 * SO: THIRTEEN ATTACKS, AND FOUR DECAYS TO PROVE THE RIG
 *
 * The attacks span 30 to 99. The decays are the control, and they are the reason this run
 * can conclude anything: if the decays land on the shared curve in the same take, by the
 * same analysis, then the attack really does have a curve of its own. If they do not, the
 * take is telling us about the measurement rather than the machine, and the attack readings
 * mean nothing either. Two of them - 70 and 85 - sit at the same settings as two attacks, so
 * the comparison is direct rather than across a model.
 *
 * WHY THESE NOTES ARE SHORT
 *
 * Nothing here needs a filter sweep watched, only a level, and an rms is as good over a
 * fortieth of a second as over a quarter of one. So the notes only have to outlast their own
 * envelope. If the attack follows its own flat curve, stored 99 lands near 2.6 s; if it
 * follows the shared one, near 10.7. The four slowest are given fourteen seconds so that
 * either answer fits inside the note, because a ramp still rising when the key comes up
 * cannot be told from a slower one that finished.
 *
 * AND THE RELEASE, WHICH NOTHING HAS EVER PINNED DOWN
 *
 * Run 4 measured the release at three settings and they landed on the shared curve - but
 * every one of them started from a sustain of 99 and fell the whole depth of the envelope.
 * That is the one case in which "takes a fixed time" and "falls at a fixed rate" predict the
 * same thing, and the engines currently use the first for the filter and the second for the
 * amplitude, in the same voice, with no measurement behind either. Section 3 settles it.
 *
 * The gaps are six seconds: the attack and decay clips all release at 0 and need nothing,
 * but the release section has a 3.15 s fall to watch and a tail under it.
 */

var VEL = 100;
var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

/// Looped, so a note lasts as long as it is held - the same as run 4 and for the same reason.
var LOOPING = true;

/*
 * The filter is held wide open and out of the way.
 *
 * Byte 44 at 99 opens the zone's own cutoff to the reconstruction limit and byte 23 at 0
 * gives the filter envelope no depth, so nothing moves but the level. A filter that moved
 * would change the rms this measures and be read as part of the amplitude envelope.
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
  44: 99, 45: 0
};

var TIMING = {
  hold: 8.0,
  gap: 6.0,               // long enough for the release section's 3.15 s and its tail
  sectionGap: 8.0,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var nextKey = 36;

function test(spec) {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(spec.set || {}).forEach(function (k) { set[k] = spec.set[k]; });

  TESTS.push({
    section: spec.section, analysis: spec.analysis, label: spec.label,
    key: nextKey++, velocity: VEL, hold: spec.hold || TIMING.hold,
    set: set, why: spec.why, setting: spec.setting,
    rising: spec.rising === true, watch: spec.watch || 'level'
  });
}

/*
 * 1. The attack, from silence to full, at thirteen settings.
 *
 * Decay 0 and sustain 99, so the ramp runs straight to the top and stays there: the plateau
 * is the full-scale reference every point on the rise is measured against, and without it
 * "reached full" would have nothing to mean.
 *
 * The holds are sized for the slower of the two candidate curves, not the likelier one. A
 * ramp that is still climbing when the note ends reads as whatever fraction of it was
 * visible, which is exactly the error this run exists to correct.
 */
[[30, 6], [40, 6], [50, 6], [55, 6], [60, 6],
 [65, 8], [70, 8], [75, 8], [80, 8],
 [85, 14], [90, 14], [95, 14], [99, 14]].forEach(function (band) {
  var a = band[0];
  test({
    section: 'attack', analysis: 'level', label: 'VCA attack ' + a, setting: a,
    rising: true, hold: band[1],
    set: { 3: a, 4: 0, 5: 99, 6: 0 },
    why: 'how long the amplitude takes to reach full, and whether it is a straight ramp'
  });
});

/*
 * 2. The decay, as the control.
 *
 * Sustain 0 so it falls as far as it can, and read as the time to lose twenty decibels -
 * a depth every one of these reaches long before the note ends, so the number does not
 * depend on where the fall was heading or on where the noise floor is.
 *
 * 70 and 85 pair with attacks at the same setting. If those two pairs disagree, the panel's
 * attack and decay are not the same curve, and the run has its answer from two clips before
 * any curve is fitted at all.
 */
[[60, 8], [70, 8], [80, 8], [85, 14]].forEach(function (band) {
  var d = band[0];
  test({
    section: 'decay', analysis: 'level', label: 'VCA decay ' + d, setting: d,
    hold: band[1],
    set: { 3: 0, 4: d, 5: 0, 6: 0 },
    why: 'the control: does the shared curve hold for the decay in this same take'
  });
});

/*
 * 3. The filter release: does it take the same TIME from any depth, or fall at the same RATE?
 *
 * Every release ever measured here started from a sustain of 99, so it fell the whole depth,
 * and from that one case the two models are identical. They are not identical anywhere else,
 * and the engines currently guess:
 *
 *     the VCF release falls from wherever it is TO ZERO over the release time, so a release
 *     from half depth crawls down at half speed - constant time
 *
 *     the VCA release under it falls a fixed eighty decibels over the release time from
 *     wherever it is, so the rate does not depend on the level - constant rate
 *
 * One voice, two different rules, and the filter's is the unmeasured one. A machine with one
 * envelope generator and one counter would have the second; nothing but the order the code
 * was written in argues for the first.
 *
 * Three sustains at one release setting decide it. Attack and decay are both 0, so the
 * envelope is standing still at its sustain when the key comes up and the distance it has to
 * fall is known exactly. With a release of 85 - 3.15 s by the measured curve:
 *
 *     sustain     99      60      35        depth  2.04   1.24   0.72 octaves
 *     constant time     3.15    3.15    3.15 s
 *     constant rate     3.15    1.91    1.11 s
 *
 * The amplitude release under them is 95, slow enough that the note is still 35 dB up when
 * the slowest of these has finished, and quiet enough by the next note not to run into it.
 */
[[99, 'full depth'], [60, 'three fifths'], [35, 'a third']].forEach(function (band) {
  test({
    section: 'release', analysis: 'trajectory', label: 'release from ' + band[1],
    setting: band[0], hold: 4.0, watch: 'filter',
    set: { 44: 50, 23: 12, 34: 0, 35: 0, 36: band[0], 37: 85, 6: 95 },
    why: 'whether the filter release takes a fixed time or falls at a fixed rate'
  });
});

/*
 * And one released in the middle of its own attack.
 *
 * The same question asked a second way, and it also checks the thing the first three cannot:
 * that the release starts from where the envelope HAS GOT TO rather than from its sustain. An
 * attack of 85 takes 3.15 s, so letting go at 1.5 is a little under halfway up.
 *
 *     constant time   3.15 s from about 0.48 depth
 *     constant rate   1.51 s
 */
test({
  section: 'release', analysis: 'trajectory', label: 'let go mid-attack', setting: 0,
  hold: 1.5, watch: 'filter',
  set: { 44: 50, 23: 12, 34: 85, 35: 99, 36: 99, 37: 85, 6: 95 },
  why: 'that the release leaves from where the envelope actually was'
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
      note: c.key, velocity: c.velocity, first: first, rising: c.rising, watch: c.watch,
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
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, LOOPING: LOOPING,
  FROM: 99, OPEN_FROM: 99, CLOSE_FROM: 99, RELEASE_FROM: 99, AMOUNT: 0,
  schedule: schedule, keygroups: keygroups, clips: clips
};
