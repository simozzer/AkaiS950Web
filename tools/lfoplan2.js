/*
 * The aftertouch run: keygroup byte 21, which every engine here reads and drops.
 *
 *   node lfodisk.js build LFOCAL2       --plan lfoplan2.js
 *   node lfomidi.js AkaiLfoAftertouch.mid --plan lfoplan2.js
 *   node lfocal.js  take.wav              --plan lfoplan2.js
 *
 * WHY THIS EXISTS, AND WHY IT SHOULD HAVE EXISTED SOONER
 *
 * Byte 21 scales the LFO's depth from channel pressure, exactly as byte 22 does from the
 * modwheel. The modwheel's law was measured - 72.3 cents at full, and byte 22 = 50 giving
 * 0.509 of it where proportional predicts 0.505. Byte 21 was never measured and never
 * modelled: the plugin has no channel-pressure handling at all.
 *
 * The reason given was that byte 21 is 0 in every one of the 1908 keygroups on the disks
 * to hand, "so nothing on any disk plays wrongly". That is the wrong test, and it is worth
 * writing down why rather than quietly fixing it. Those 1908 keygroups are ONE PERSON'S
 * SHELF OF DISKS. This is a tool other people point at their own libraries, and a byte
 * nobody here happens to set is not a byte nobody sets - it is a byte with no evidence
 * either way, and "no evidence" was being recorded as "no problem".
 *
 * Ranking work by how many library keygroups something touches is fair. Deciding what
 * counts as a BUG that way is not.
 *
 * WHAT IT MEASURES
 *
 *   A  THE TRAVEL.  One long note with the pressure climbing in steps, the keygroup's own
 *      depth at zero so everything heard was added by aftertouch. Nine steps across the
 *      full range gives the whole curve in a single clip, which is how the modwheel
 *      section does it and why that one only needed one note.
 *   B  THE LAW OF BYTE 21 ITSELF.  Full pressure at byte 21 = 50 rather than 99. If the
 *      ratio to the full-depth reading is about 0.5 the byte is proportional, which is
 *      what byte 22 turned out to be; anything else and the two controllers do not share
 *      a law after all.
 *   C  DO THEY ADD?  Both byte 21 and byte 22 set, and both controllers pushed to full.
 *      Nobody has ever had them on at once. If the readings sum, the two are independent
 *      paths into one depth; if the answer saturates at the larger of them, they are not.
 *      This is the case a player actually creates - a hand on the wheel and weight on the
 *      key - and it is one note.
 *
 * WHAT IT DOES NOT TRY TO DO
 *
 * Aftertouch on the S950 is CHANNEL pressure, one value for the whole keyboard, not per
 * key. So there is nothing here about polyphonic pressure: the machine has no such input,
 * and a run that sent it would be measuring the MIDI implementation rather than the byte.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04, FLAG_ONE_SHOT = 0x08;

var VEL = 100;
var TONE_HZ = 400;
var ROOT = 60;
var FIRST_KEY = 36;

/*
 * As lfoplan.js: the gate flat so the tone holds steady and any wobble came from the LFO,
 * the filter wide open with no envelope amount so it cannot colour the tone as the pitch
 * moves past it, and desync on, which is the library's common case and gives the delay a
 * known zero.
 *
 * Byte 16 is the rate and 17 the keygroup's OWN depth. 17 stays at 0 through the first two
 * sections: everything read there was put in by a controller.
 */
var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  15: 0, 16: 60, 17: 0,
  18: FLAG_DESYNC,
  21: 0, 22: 0,
  23: 0,
  43: 0,
  44: 99, 45: 0
};

var MID_RATE = 60;

var TIMING = {
  lead: 2.0,
  gap: 1.5,
  sectionGap: 3.0,
  channel: 0
};

var TESTS = [];
var nextKey = FIRST_KEY;

/**
 * One test, one keygroup, one clip.
 *
 * `steps` is the controller ramp, and it goes in the clip's `cc` field whichever
 * controller sends it - the analysis only needs the values and their timing. `source`
 * says which the MIDI writer should use: 'cc' for the modwheel, 'pressure' for channel
 * aftertouch.
 */
function test(spec) {
  var key = spec.key === undefined ? nextKey++ : spec.key;
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(spec.set || {}).forEach(function (k) { set[k] = spec.set[k]; });

  TESTS.push({
    section: spec.section, analysis: spec.analysis, label: spec.label,
    sample: spec.sample || 'SINE', key: key, velocity: VEL,
    hold: spec.hold || 0, set: set, why: spec.why, setting: spec.setting,
    cc: spec.steps || null, source: spec.source || 'cc',
    also: spec.also || null,
    pairWith: null, stagger: 0,
    sounds: TONE_HZ * Math.pow(2, (key - ROOT) / 12),
    hasClip: true
  });
  return key;
}

/*
 * A. THE TRAVEL, in nine steps up one long note.
 *
 * 1.3 s a step, which is what the modwheel section uses: long enough at rate 60 to hold
 * plenty of cycles for the demodulator to bin, and the analysis throws away the first
 * 0.35 s of each step so the machine has settled before anything is read.
 */
var touchSteps = [];
for (var i = 0; i <= 8; i++)
  touchSteps.push({ at: 0.2 + i * 1.3, value: Math.min(127, i * 16) });

test({
  section: 'aftertouch', analysis: 'touch',
  label: 'pressure 0..127 at depth->aftertouch 99',
  hold: 12, set: { 16: MID_RATE, 17: 0, 21: 99 },
  steps: touchSteps, source: 'pressure',
  why: 'aftertouch adds depth: how much, across its travel'
});

/*
 * B. AND THE LAW OF THE BYTE, from its default rather than its top.
 *
 * Byte 22 measured 0.509 of full at 50, against 0.505 for a straight proportion - so the
 * modwheel's byte is simply a fraction. One clip says whether byte 21 is the same.
 */
test({
  section: 'aftertouch', analysis: 'touchhalf',
  label: 'pressure 127 at depth->aftertouch 50', setting: 50,
  hold: 5, set: { 16: MID_RATE, 17: 0, 21: 50 },
  steps: [{ at: 0, value: 127 }], source: 'pressure',
  why: 'the same pressure at the middle of byte 21, for the shape of that law'
});

/*
 * C. BOTH AT ONCE, WHICH NOBODY HAS EVER TRIED.
 *
 * Byte 21 and byte 22 both at 99, the wheel pushed up and held, and then the pressure
 * pushed up on top of it. Three readings come out of the one note: the wheel alone, and
 * then both together.
 *
 * If depth adds, the second reading is about twice the first. If the machine takes the
 * larger of the two, it is the same. Either answer is worth having and neither is
 * currently modelled, because the engines do not read byte 21 at all - so today the
 * plugin gives the wheel's contribution and nothing else however hard the key is leant on.
 *
 * `also` carries the second controller's ramp. The wheel goes first and stays up, so the
 * step boundaries in `cc` still line up with what the analysis reads.
 */
test({
  section: 'together', analysis: 'touchboth',
  label: 'wheel then pressure, both bytes at 99',
  hold: 9, set: { 16: MID_RATE, 17: 0, 21: 99, 22: 99 },
  steps: [{ at: 0.2, value: 0 }, { at: 4.2, value: 127 }], source: 'pressure',
  also: { source: 'cc', steps: [{ at: 0.1, value: 127 }] },
  why: 'a hand on the wheel and weight on the key - do the two depths add?'
});

/*
 * A CONTROL, and the run needs one.
 *
 * The keygroup's own depth at 50 with both controller bytes at zero. It should read the
 * same as the rate ladder in lfoplan.js did at the same setting, which is what says the
 * take is comparable to that one at all - and if section A reads nothing, this is what
 * separates "aftertouch does nothing" from "the pressure never arrived".
 */
test({
  section: 'control', analysis: 'depth', label: 'keygroup depth 50, no controllers',
  setting: 50, hold: 5, set: { 16: MID_RATE, 17: 50 },
  why: 'the LFO working with nothing touched, so a silent section A means something'
});

function schedule() {
  // Both controllers parked, so nothing carries in from whatever was played before.
  var events = [
    { at: 0, kind: 'cc', controller: 1, value: 0 },
    { at: 0, kind: 'pressure', value: 0 }
  ];
  var clips = [];
  var at = TIMING.lead;
  var section = null;

  TESTS.forEach(function (c) {
    var first = c.section !== section;
    if (clips.length) at += first ? TIMING.sectionGap : TIMING.gap;
    section = c.section;

    var from = at;
    events.push({ at: at, kind: 'on', note: c.key, velocity: c.velocity });

    if (c.also)
      c.also.steps.forEach(function (p) {
        events.push(c.also.source === 'pressure'
          ? { at: at + p.at, kind: 'pressure', value: p.value }
          : { at: at + p.at, kind: 'cc', controller: 1, value: p.value });
      });

    (c.cc || []).forEach(function (p) {
      events.push(c.source === 'pressure'
        ? { at: at + p.at, kind: 'pressure', value: p.value }
        : { at: at + p.at, kind: 'cc', controller: 1, value: p.value });
    });

    events.push({ at: at + c.hold, kind: 'off', note: c.key });
    var to = at + c.hold;

    // Put both controllers back where they were found. A hand left on a wheel is exactly
    // the kind of thing that ruins a take quietly, and pressure left up is worse: there is
    // no physical control sitting in the wrong place to notice.
    if (c.cc || c.also) {
      events.push({ at: to + 0.05, kind: 'cc', controller: 1, value: 0 });
      events.push({ at: to + 0.05, kind: 'pressure', value: 0 });
    }

    clips.push({
      section: c.section, analysis: c.analysis, label: c.label, setting: c.setting,
      sample: c.sample, note: c.key, velocity: c.velocity, hold: c.hold,
      first: first, from: from, to: to, sounds: c.sounds,
      pairWith: null, stagger: 0, cc: c.cc, source: c.source
    });

    at = to;
  });

  events.sort(function (a, b) { return a.at - b.at; });
  return { events: events, clips: clips, seconds: at + 1.0 };
}

function keygroups() {
  return TESTS.map(function (t) {
    return { key: t.key, sample: t.sample, set: t.set, why: t.why };
  });
}

function clips() { return schedule().clips; }

function samplesUsed() {
  var seen = [];
  TESTS.forEach(function (t) { if (seen.indexOf(t.sample) < 0) seen.push(t.sample); });
  return seen;
}

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE,
  TONE_HZ: TONE_HZ, ROOT: ROOT, VEL: VEL, MID_RATE: MID_RATE,
  FLAG_CONSTANT_PITCH: FLAG_CONSTANT_PITCH, FLAG_DESYNC: FLAG_DESYNC,
  FLAG_ONE_SHOT: FLAG_ONE_SHOT,
  schedule: schedule, clips: clips, keygroups: keygroups, samplesUsed: samplesUsed
};
