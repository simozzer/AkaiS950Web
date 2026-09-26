/*
 * The nineteenth run: filling gaps rather than exploring.
 *
 *   node envdisk.js  build ENVCAL19           --plan envplan19.js
 *   node envmidi.js  AkaiEnvCalibration19.mid --plan envplan19.js
 *   node envcal.js   take.wav ENVCAL19.img    --plan envplan19.js
 *
 * WHY THIS RUN EXISTS
 *
 * An audit of how densely each constant is actually sampled, weighted by what the 1908
 * keygroups on the real disks use, came out uncomfortable:
 *
 *     ENV_TIME     eleven points, and a FIFTY-BYTE GAP from 0 to 50 with nothing in it
 *     SUSTAIN_DB   ONE point, at stored 50, scaled to the whole range - and known wrong
 *
 * ENV_TIME is the curve behind every envelope stage the machine has, and 790 of the 1908
 * keygroups - two in five - set a VCA release inside that gap. The median release is 55,
 * barely above the lowest measured point. 189 of the 247 keygroups with a real VCF envelope
 * set an attack in there too. And the gap is already known to be wrong: the crossfade work
 * turned up ENV_TIME reading about 20% slow around stored 45, found sideways rather than by
 * anyone looking for it.
 *
 * WHY THE INTERPOLATION CANNOT BE TRUSTED, WHICH IS NOT THE OBVIOUS REASON
 *
 * The table does not interpolate badly. It goes straight in LOG time, so the gap is filled
 * geometrically at 1.0729 per byte, and above 50 the measured points average 1.071 per byte -
 * the two agree, and the endpoint at stored 0 that nobody interpolated sits where that shape
 * puts it to eleven per cent. As a smooth curve through the gap it is about as good a guess
 * as could be made.
 *
 * THE PROBLEM IS THAT THE STAGE IS ALMOST CERTAINLY NOT SMOOTH.
 *
 * Read the measured points as ratios rather than as a curve:
 *
 *     stored      50     55     60     65     70     80     85     90     95     99
 *     seconds  .3565  .4184  .7224  .8806 1.4037 2.8136 4.0370 4.1172 8.0947 10.740
 *     ratio           1.17   1.73   1.22   1.59          1.435  1.020  1.966
 *
 * They lurch. And 85 to 90 is a ratio of 1.02 - the same reading twice over, which is not
 * what a curve does and is exactly what a COUNTER does. The VCA attack turned out to be
 * precisely that: 5.4/n for whole-number n, thirteen settings to within 0.7%, with 70 and 75
 * identical to four digits because they share an n, and 90, 95 and 99 all landing on 2.70 s.
 * It looked like a smooth curve until somebody measured enough of it.
 *
 * If ENV_TIME is a counter too, the gap contains plateaus and steps, and NO smooth
 * interpolation reproduces those however well it is fitted through the ends. The 20% error
 * already found around stored 45 is what one of them would look like from outside.
 *
 * That is the case for measuring the gap: not that the guess is careless, but that the guess
 * is of the wrong KIND of thing, and two in five keygroups sit inside it.
 *
 * WHAT MAKES THIS MEASURABLE NOW AND WAS NOT BEFORE
 *
 * The release turned out to be a RATE - 40 dB in one release time, over sixteen clips from
 * stored 20 to 95 - so timing a fall measures ENV_TIME directly, with no envelope shape to
 * unpick. Before that it would have wanted the filter-corner machinery and a long note.
 *
 * WHERE THE LADDERS STOP, AND WHY
 *
 * They stop at the bottom because of the RECORDING, not the machine. An rms needs samples:
 * 88 of them - two milliseconds - give a level good to about 0.7 dB, and the fit wants some
 * twenty-five windows across the fall it is timing. Both ladders reach stored 15, where the
 * fall lasts about sixteen milliseconds; rendering this exact run through the emulation and
 * reading it back puts every clip within 1.3 dB of a straight line and recovers the rates to
 * four per cent, so the bottom rung is at the edge of the method rather than over it.
 *
 * Below 15 it IS over it, and nothing here goes there. That leaves 0 to 15 bracketed by the
 * measured endpoint at stored 0 rather than measured - a span of four, against the span of
 * thirty-five that these ladders close. Reaching into it would want the amplitude tracked by
 * Goertzel on a tone instead of by rms on noise, which is a different rig and a later run.
 *
 * SECTIONS
 *
 *   A  RELEASE   Stored 15 to 55. Seven of the nine are inside the gap; 50 and 55 are already
 *                measured and are the check that this method agrees with the old one where
 *                they overlap.
 *   B  SUSTAIN   Thirteen settings, dense at the BOTTOM - see below.
 *   C  DECAY     Stored 15 to 50 - eight of section A's nine, so the two ladders can be
 *                compared rung for rung rather than over a shared range. It asks whether
 *                the decay reads the same curve as the release below 50, the way the two
 *                agree above it. If they part, ENV_TIME is not one curve and section A
 *                measures only the release.
 *   D  LOUDNESS  Run 18's section H, never recorded: velocity to loudness at 40 across a
 *                crossfade, which also measures VEL_DB_PER_STEP from its two reference keys.
 *   E  FILTER    Run 18's section I: velocity to filter at 50 from a zone filter of 60.
 *
 * D and E are here because the machine is out anyway. They ask whether the crossfade is
 * independent of the two paths velocity drives, which decides whether its gain can be worked
 * out once at note-on and multiplied in or has to be tangled up with them.
 *
 * Sections A, B and C use noise and D and E use tones, because a level is all the first three
 * need and broadband rms is the steadiest thing to read, while the last two have to separate
 * two keygroups sounding at once and that wants two frequencies.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

var TONES = [1000, 2200];

var SAMPLES = [
  { name: 'NOISE', kind: 'noise', frames: 8820, loopMode: 'L', loopLength: 8820 },
  { name: 'T1', kind: 'tone', hz: TONES[0], frames: 4410, loopMode: 'L', loopLength: 4410 },
  { name: 'T2', kind: 'tone', hz: TONES[1], frames: 4410, loopMode: 'L', loopLength: 4410 }
];

/// Byte 21 of the programme header: the crossfade, on. D and E need it; A, B and C have no
/// overlaps for it to act on.
var HEADER = { 21: 255 };

var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,          // VCA attack, decay, sustain, release
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  12: 0, 13: 0, 14: 0,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  19: 0xFF,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,     // VCF envelope, flat
  43: 0,
  44: 99, 45: 0                     // zone filter wide open, zone loudness nominal
};

/*
 * TIMING.gap IS THE SHORTEST GAP IN THE RUN, AND HAS TO BE.
 *
 * It is what the note splitter is tuned to - it will not separate two notes closer together
 * than half of it - so it states the floor rather than the typical. The release ladder needs
 * far more room than that to be watched through, and says so per clip through gapAfter, which
 * envcal now reads in preference where it has one.
 */
var TIMING = {
  hold: 1.0,
  gap: 0.8,
  sectionGap: 1.5,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var KEYGROUPS = [];

function keygroup(low, high, sample, extra) {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(extra || {}).forEach(function (k) { set[k] = extra[k]; });
  set[0] = high; set[1] = low;
  KEYGROUPS.push({ low: low, high: high, set: set, sample: sample,
                   why: sample + ' over keys ' + low + ' to ' + high });
}

function note(spec) {
  TESTS.push({
    section: spec.section, analysis: spec.analysis, label: spec.label,
    key: spec.key, velocity: spec.velocity === undefined ? 127 : spec.velocity,
    hold: spec.hold, gapAfter: spec.gapAfter,
    setting: spec.setting, rising: false, watch: spec.analysis, why: spec.why
  });
}

/*
 * A. THE RELEASE LADDER - keys 24 up, one keygroup per setting.
 *
 * Attack 0 and sustain 99, so the note is at full level from its first sample and there is
 * nothing to wait for: eight tenths of a second of it is plenty to establish where it started
 * from. Then the fall is watched through the gap.
 *
 * 1.6 s of gap because the slowest of these, stored 55, takes 0.42 s to lose its first 40 dB
 * and about 0.8 s to reach the noise floor. The fit only needs the first 20, but a gap that
 * ends while the note is still audible leaves the splitter looking for the next onset inside
 * a decaying tail.
 *
 * The section is called "release" exactly - that is what tells envcal to trace from the key
 * coming UP rather than from the strike.
 */
var relKey = 24;
[15, 20, 25, 30, 35, 40, 45, 50, 55].forEach(function (stored) {
  keygroup(relKey, relKey, 'NOISE', { 6: stored });
  note({ section: 'release', analysis: 'level', label: 'release ' + stored,
         key: relKey, hold: 0.8, gapAfter: 1.6, setting: stored,
         why: stored >= 50 ? 'already measured - the check that this method agrees'
                           : 'ENV_TIME where nothing has ever been measured' });
  relKey++;
});

/*
 * B. THE SUSTAIN LADDER - keys 34 up.
 *
 * DENSE AT THE BOTTOM, WHICH IS THE WHOLE POINT. SUSTAIN_DB is 39.6 because a stored 50 read
 * 19.6 dB down and that was scaled across the range on the assumption of a straight count in
 * decibels. But a stored 0 falls at LEAST 77 dB, which is twice what the line predicts. So
 * the scale bends somewhere below 50 and one reading cannot say where - hence 0, 5, 10, 15
 * and 20 before the spacing opens out. Half the library sets a sustain.
 *
 * Decay 65, about 0.88 s, chosen from both ends: slow enough that the first 8 ms window is
 * still within a decibel of full level, which is what the plateau gets measured against, and
 * fast enough to have settled long before a 2.4 s note ends.
 *
 * AND A SECOND ANSWER FOR FREE. Whether the VCA decay is a RATE or a DURATION has never been
 * measured - the filter's is modelled as a duration and the amplitude's is assumed to match.
 * These thirteen notes settle it: a duration puts every plateau at the same moment whatever
 * its depth, a rate gets the shallow ones there sooner. The traces show it without anything
 * being added to the run.
 */
var susKey = 34;
[0, 5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 99].forEach(function (stored) {
  keygroup(susKey, susKey, 'NOISE', { 4: 65, 5: stored });
  note({ section: 'sustain', analysis: 'level', label: 'sustain ' + stored,
         key: susKey, hold: 2.4, gapAfter: 0.8, setting: stored,
         why: stored === 99 ? 'no fall at all - the reference the rest are read against'
                            : 'SUSTAIN_DB, which rests on one reading at stored 50' });
  susKey++;
});

/*
 * C. THE DECAY LADDER - keys 48 up, sustain 0 so the decay runs its whole length.
 *
 * Above 50 the decay and the release agree on one curve to 1.07x. Whether they still do below
 * it decides what section A measured: one shared ENV_TIME, or a release curve that happens to
 * resemble a decay curve above 50.
 *
 * The same eight settings as the release ladder, so the comparison is rung for rung. These
 * are the faster of the two - the decay covers the whole sustain depth in one decay time,
 * against the release's 40 dB - but the dry run reads stored 15 at a 1.2 dB residual, which
 * is the same edge the release ladder sits on rather than a worse one.
 */
var decKey = 48;
[15, 20, 25, 30, 35, 40, 45, 50].forEach(function (stored) {
  keygroup(decKey, decKey, 'NOISE', { 4: stored, 5: 0 });
  note({ section: 'decay', analysis: 'level', label: 'decay ' + stored,
         key: decKey, hold: 1.4, gapAfter: 0.8, setting: stored,
         why: 'whether decay and release read the same curve below 50' });
  decKey++;
});

/*
 * D. VELOCITY TO LOUDNESS ACROSS A CROSSFADE - run 18's section H, carried over.
 *
 * Overlap 62-64, so x is 1/4, 1/2 and 3/4, which run 17's cos(pi x / 2) ^ 1.44 puts at -1.2,
 * -4.5 and -11.5 dB. Those are the numbers the balance has to keep while the level slides
 * 29 dB underneath it.
 *
 * Depth 40 rather than 99. Run 17's equivalent used 99, which spans some 74 dB and put its two
 * lowest velocities at and under the noise floor - two usable readings out of five, 3 dB
 * apart, and no way to tell an interaction from the limit of reading a tone at -36 dB. 40
 * keeps every velocity well clear of the floor while still moving the level visibly, which
 * also means a silent MIDI fault cannot be mistaken for a null result. Run 17's OTHER section
 * had exactly that problem: velocity to loudness at zero, so an identical reading at five
 * velocities is equally what a dead velocity byte would produce.
 *
 * Keys 58 and 68 sound one keygroup alone, so they are both the per-velocity reference the
 * balance is read against and a direct measurement of VEL_DB_PER_STEP - which is 0.63 in the
 * model, came out at 0.585 when run 17 was read sideways for it, and has never been measured
 * by anything built to measure it.
 */
keygroup(58, 64, 'T1', { 11: 40 });
keygroup(62, 68, 'T2', { 11: 40 });

[1, 32, 64, 96, 127].forEach(function (v) {
  [58, 62, 63, 64, 68].forEach(function (k) {
    note({ section: 'D loudness', analysis: 'mix', label: 'D key ' + k + ' at ' + v,
           key: k, velocity: v, hold: 1.0, gapAfter: 0.8, setting: k,
           why: 'does the balance hold while the level slides underneath it' });
  });
});

/*
 * E. VELOCITY TO FILTER ACROSS A CROSSFADE - run 18's section I.
 *
 * THE ZONE FILTER IS 60 HERE, NOT 99, AND THAT IS THE WHOLE DIFFERENCE. Velocity to filter
 * shifts the cutoff in octaves from wherever the zone filter puts it, and from 99 it is
 * already at the machine's ceiling: a velocity of 1 only brings it down to 3747 Hz, above both
 * tones. The dry run of run 18 showed that for what it was - a flat line at every velocity,
 * measuring nothing. From 60 the sweep lands where it is wanted: 1097 Hz at velocity 1,
 * between the two tones, through 2238 at 32 to 4670 at 64.
 *
 * Velocities stop at 64 because the response turns about 65 and does nothing above it.
 *
 * The balance MUST move here - 2200 Hz is 1.14 octaves above 1000, and a sixth-order filter
 * takes the upper tone down far harder once the cutoff is below both. That is the point: the
 * filter's own effect is predictable, so what matters is the residual once it is taken out.
 * A residual of nothing puts the crossfade before the filter and untouched by it.
 */
keygroup(72, 78, 'T1', { 7: 50, 44: 60 });
keygroup(76, 82, 'T2', { 7: 50, 44: 60 });

[1, 16, 32, 48, 64].forEach(function (v) {
  [72, 76, 77, 78, 82].forEach(function (k) {
    note({ section: 'E filter', analysis: 'mix', label: 'E key ' + k + ' at ' + v,
           key: k, velocity: v, hold: 1.0, gapAfter: 0.8, setting: k,
           why: 'whether the balance moves by exactly what the filter predicts, or by more' });
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
      note: c.key, velocity: c.velocity, first: first, rising: c.rising, watch: c.watch,
      from: at, releasedAt: at + c.hold, hold: c.hold, gapAfter: c.gapAfter
    });

    at += c.hold;
  });

  return { events: events, clips: clips, seconds: at + 2.0 };
}

function overlaps() {
  return [
    { section: 'D loudness', from: 62, to: 64 },
    { section: 'E filter',   from: 76, to: 78 }
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
