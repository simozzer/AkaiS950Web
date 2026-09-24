/*
 * The fourth filter run: long notes, slow sweeps, and the attack at last.
 *
 *   node envdisk.js  build ENVCAL4           --plan envplan4.js
 *   node envmidi.js  AkaiEnvCalibration4.mid --plan envplan4.js
 *   node envcal.js   take.wav ENVCAL4.img    --plan envplan4.js
 *
 * WHY THE NOTES ARE FOURTEEN SECONDS LONG
 *
 * Everything difficult about the last three runs came from one thing: a three-second sample
 * meant every envelope had to be fast, and a fast sweep can only be followed in short
 * windows, and a short window cannot measure a corner. So the crossings carried a tenth of a
 * second of scatter, and asking them for the SHAPE of the fall was asking for a second
 * derivative out of noise. It never came.
 *
 * The sample loops here. That costs nothing - the same three seconds of noise, with its loop
 * points set - and a note then lasts as long as the key is held. Which means the envelope can
 * be slow: a decay of 95 takes nine seconds, and over nine seconds a half-second window
 * smears the sweep by a tenth of an octave while measuring the corner to a hundredth. That is
 * the static measurement this rig has always been good at, taken twenty times down one sweep,
 * instead of a moving one chased with short noisy windows.
 *
 * AND WHY THE GAPS ARE EIGHT SECONDS
 *
 * The slowest filter release here is stored 90, which the model puts at 5.7 seconds, and the
 * amplitude release holding the note up while it happens is stored 90 too - 7.3 seconds to
 * fall the four decades that count as silence. Five seconds covered neither: the release
 * would still have been moving when the gap ran out, and the tail of each note would have
 * been inside the next, which the splitter reads as one clip. That is the sort of fault that
 * looks like a bad measurement rather than a bad plan.
 *
 * Eight outlasts both with a second to spare, and costs a minute across the whole run.
 *
 * WHAT IT ANSWERS
 *
 *   the attack       never measured at all. The model's attack is the decay's scale taken
 *                    on trust, and a rising sweep is as easy to read as a falling one when
 *                    there is time for it. Seven settings, four of them in the middle of the
 *                    range where the library sits and where nothing has ever been read.
 *   the shape        linear or exponential, decided on twenty points instead of eight
 *                    crossings.
 *   the bottom       run 3 read 224 Hz where the model puts a hard floor at 311, and its
 *                    low band swept half again as fast as it should have. Both say the
 *                    bottom of the travel is not what the model thinks.
 */

var VEL = 100;
var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

/// The sample loops, so a note lasts as long as it is held. This is what the run rests on.
var LOOPING = true;

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

var FROM = 50;              // stored 50, measured 2210 Hz - room both ways
var AMOUNT = 12;            // 2.04 octaves at the measured 8.5, clear of both stops

var TIMING = {
  hold: 14.0,             // long enough for a decay of 95 to finish and be watched
  releaseHold: 4.0,       // held until the envelope has settled, then let go
  gap: 8.0,               // outlasts the slowest release here AND the amplitude under it
  sectionGap: 10.0,
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
    rising: spec.rising === true, watch: spec.watch || 'filter'
  });
}

/*
 * 1. The attack, which nothing has ever measured.
 *
 * Sustain at full, so the cutoff climbs to the top of the envelope's travel and stays there -
 * the rise is the whole of what moves, and the settled value at the end gives the depth as a
 * static corner into the bargain.
 */
/*
 * Seven of them, not three, and most of them in the middle.
 *
 * 70, 80 and 90 are all slow - 0.9, 2.2 and 5.6 seconds by the model - so a ladder of those
 * three says nothing about the half of the range the library actually uses. The extra four
 * sit in a band from 50 to 65, where the model puts the attack between a seventh of a second
 * and half of one, and where any error in the time law is worth the most: the curve is
 * exponential, so a scale that is wrong by a fifth is a tenth of a second here and a whole
 * second at the top, and only the top has ever been measured.
 *
 * The fast four are held six seconds rather than fourteen. There is nothing to watch after
 * the rise has finished, and a shorter hold keeps the run near five minutes; the settled
 * corner that follows is measured over five of those six, which is as static a reading as
 * this rig ever gets.
 *
 * At 50 the rise is shorter than two analysis windows, so the shape will not come out of it.
 * That is expected - it is there to bound the TIME, and the settled corner beside it to
 * confirm the depth is the same at the fast end as at the slow one.
 */
[[50, 6], [55, 6], [60, 6], [65, 6], [70, 8], [80, 14], [90, 14]].forEach(function (band) {
  var a = band[0];
  test({
    section: 'attack', analysis: 'trajectory', label: 'attack ' + a, setting: a, rising: true,
    hold: band[1],
    set: { 44: FROM, 23: AMOUNT, 34: a, 35: 99, 36: 99, 37: 0 },
    why: 'how long the filter envelope takes to rise, and in what shape'
  });
});

/*
 * 2. The decay, slowly enough to read properly this time.
 */
[85, 90, 95].forEach(function (d) {
  test({
    section: 'decay', analysis: 'trajectory', label: 'decay ' + d, setting: d,
    set: { 44: FROM, 23: AMOUNT, 34: 0, 35: d, 36: 0, 37: 0 },
    why: 'the fall, twenty measured points instead of eight crossings'
  });
});

/*
 * 3. The release, held until it has settled and then let go.
 *
 * Four seconds of hold is longer than any attack here needs, so the envelope is at its
 * sustain and standing still when the key comes up - which means the release starts from a
 * known place rather than from wherever a decay had got to.
 *
 * THE AMPLITUDE RELEASE UNDER IT IS AT 99, NOT 90
 *
 * Both releases start on the same key-up, so the note can only be watched for as long as it
 * is still audible: at stored 90 the amplitude falls four decades in 7.3 seconds, which puts
 * it under the measurable by 3 - and the filter release being measured takes 5.7. The trace
 * stopped a third of the way down and reported a release half as long as it was.
 *
 * At 99 the amplitude takes 16.8 seconds, so it is still 27 dB up when a release of 90 has
 * finished. The cost is a tail that is quiet rather than silent when the next note begins,
 * which is what the eight-second gap is now long enough to absorb.
 */
[70, 80, 90].forEach(function (r) {
  test({
    section: 'release', analysis: 'trajectory', label: 'release ' + r, setting: r,
    hold: TIMING.releaseHold,
    set: { 44: FROM, 23: AMOUNT, 34: 0, 35: 99, 36: 99, 37: r, 6: 99 },
    why: 'the release, from a settled start and with time to finish'
  });
});

/*
 * 4. The bottom of the travel, where run 3 disagreed with the model twice over.
 *
 * A negative amount from a low base drives the cutoff at the floor. The model clamps at
 * 311 Hz; run 3 measured 224.
 *
 * THE SUSTAIN HAS TO BE AT FULL, NOT AT ZERO
 *
 * These clips first asked for attack, decay, sustain and release all at zero, on the
 * reasoning that a still envelope is the easiest thing to measure. It is also a MISSING one:
 * the amount scales the envelope's output, so an envelope resting at zero gives zero however
 * large the amount, and both clips came back at 1133 Hz - the bare base, to the digit,
 * proving only that the run had not tested anything. Sustain at 99 holds the envelope at full
 * for the length of the note, which is what the amount needs in order to reach the cutoff.
 *
 * Four amounts rather than two, chosen against a base of stored 40 - 1138 Hz - so that two
 * land above the floor and two are driven well under it. The pair above measure the slope on
 * the way down, and the pair below ask whether there is a stop at the bottom at all: if there
 * is, those two agree with each other and with nothing else, and if there is not, all four
 * fall on one line and the line says where the bottom really is.
 *
 * The amount is a plus-or-minus FIFTY parameter, as the panel shows it - not 0..99 - so it
 * moves 0.17 octaves per unit and the useful range down from this base is only a dozen
 * units. Sized as if it were 0..99 the first attempt put every one of the four past the
 * clamp, where they agreed at 311 Hz and measured nothing but each other.
 *
 *     -4  ->  710 Hz     -8  ->  443 Hz     -12  ->  274 Hz     -20  ->  108 Hz
 *                                           (both of those ask for below the 311 clamp)
 */
[4, 8, 12, 20].forEach(function (a) {
  test({
    section: 'the floor', analysis: 'settled', label: 'amount -' + a, setting: -a,
    set: { 44: 40, 23: (256 - a) & 0xFF, 34: 0, 35: 99, 36: 99, 37: 0 },
    why: 'whether the floor is where the model puts it'
  });
});

/*
 * 5. The amplitude envelope, on the same long notes.
 *
 * Its attack was measured once, from a clip whose start the splitter had trimmed, and the
 * two readings of it disagreed by 20%. With fourteen seconds and a looping sample it can be
 * watched from silence to full without any of that.
 */
[70, 85].forEach(function (a) {
  test({
    section: 'level attack', analysis: 'level', label: 'VCA attack ' + a, setting: a,
    rising: true, watch: 'level',
    set: { 44: 99, 23: 0, 3: a, 4: 0, 5: 99, 6: 0 },
    why: 'the amplitude attack, from silence, with time to reach the top'
  });
});

[85, 95].forEach(function (d) {
  test({
    section: 'level decay', analysis: 'level', label: 'VCA decay ' + d, setting: d,
    watch: 'level',
    set: { 44: 99, 23: 0, 3: 0, 4: d, 5: 0, 6: 0 },
    why: 'the amplitude decay, all the way to nothing'
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
  FROM: FROM, OPEN_FROM: FROM, CLOSE_FROM: FROM, RELEASE_FROM: FROM, AMOUNT: AMOUNT,
  schedule: schedule, keygroups: keygroups, clips: clips
};
