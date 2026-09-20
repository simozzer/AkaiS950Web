/*
 * Build - or check - the LFOCAL disk that the LFO calibration run plays.
 *
 *   node lfodisk.js build [out]      writes out.img and out.hfe   (default tools/LFOCAL)
 *   node lfodisk.js check [image]
 *
 * Unlike the filter run's disk, this one is made from nothing: three tones generated
 * here, and a programme of 28 keygroups written from lfoplan.js. Nothing of anyone
 * else's audio is on it, so it can be rebuilt byte for byte by anyone who has the repo
 * and does not need to be carried in it.
 *
 * THE TONES
 *
 * 250 Hz at 20 kHz, which makes a period exactly 80 words, and 125 periods exactly
 * 10,000 words. The loop is the whole sample, so it joins onto itself with no
 * discontinuity at all - not nearly none, none: the last word is followed by the first
 * and the waveform carries on as though nothing happened. A loop that clicked once per
 * half second would put a spike into the pitch track every time round, and the analysis
 * would read it as modulation.
 *
 *   SAW    36 harmonics. The one the ladders play: strong, evenly spaced partials.
 *   SINE   the fundamental alone. Nothing to hide behind, so a wobble in the level is
 *          plainly a wobble in the level.
 *   PULSE  a quarter-width rectangle, 36 harmonics. A different spectrum entirely,
 *          played at a setting the sawtooth also plays, as a check that the reading
 *          belongs to the machine and not to the waveform.
 *
 * All three are band-limited by construction - built up from harmonics rather than
 * drawn and sampled - so there is no aliasing in them to be mistaken for anything.
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');
var plan = require('./lfoplan.js');

var args = process.argv.slice(2);
var mode = (args[0] === 'build' || args[0] === 'check') ? args.shift() : 'check';
var target = args[0] || path.join(__dirname, 'LFOCAL');

var PROGRAM = 'LFOCAL';
var RATE = 20000;                     // the tones' sample rate
var HARMONICS = 36;                   // 36 x 250 Hz = 9 kHz, clear of the 10 kHz ceiling
var PERIODS = 125;                    // 125 periods of 80 words = 10,000 words, 0.5 s
var PEAK = 1800;                      // of the 12-bit +-2047, leaving a little headroom
var DUTY = 0.25;                      // the pulse width

// keygroup byte offsets worth naming in a report
var NAMES = {
  0: 'high key', 1: 'low key',
  3: 'VCA attack', 4: 'VCA decay', 5: 'VCA sustain', 6: 'VCA release',
  7: 'vel->filter', 8: 'key->filter', 9: 'vel->attack', 10: 'vel->release',
  11: 'vel->loudness',
  15: 'LFO delay', 16: 'LFO rate', 17: 'LFO depth', 18: 'flags',
  21: 'LFO->aftertouch', 22: 'LFO->modwheel', 23: 'VCF amount',
  43: 'zone 1 transpose', 44: 'zone 1 filter', 45: 'zone 1 loudness'
};

function label(off) { return NAMES[off] ? NAMES[off] + ' (' + off + ')' : 'byte ' + off; }

// ------------------------------------------------------------------- the tones

/**
 * One cycle-exact tone, as 12-bit words.
 *
 * Built from a harmonic series evaluated at each word, so the result is periodic in
 * exactly `period` words however many harmonics it has. Normalised to PEAK afterwards
 * rather than scaled by a formula: a band-limited sawtooth overshoots a straight ramp by
 * about 9% at the discontinuity, and a pulse rather more, so the arithmetic peak is not
 * the peak.
 */
function tone(kind, period, periods) {
  var n = period * periods;
  var raw = new Float64Array(n);
  var k, i, amp, phase;

  for (i = 0; i < n; i++) {
    phase = 2 * Math.PI * (i % period) / period;
    var v = 0;

    if (kind === 'SINE') {
      v = Math.sin(phase);
    } else if (kind === 'SAW') {
      // the textbook series: every harmonic, falling as 1/k
      for (k = 1; k <= HARMONICS; k++) v += Math.sin(k * phase) / k;
    } else if (kind === 'PULSE') {
      // a rectangle of width DUTY, less its DC - sin(k.pi.d)/k weights the cosines
      for (k = 1; k <= HARMONICS; k++) {
        amp = Math.sin(k * Math.PI * DUTY) / k;
        v += amp * Math.cos(k * phase);
      }
    } else {
      throw new Error('no such tone: ' + kind);
    }
    raw[i] = v;
  }

  var peak = 0;
  for (i = 0; i < n; i++) peak = Math.max(peak, Math.abs(raw[i]));

  var out = new Int16Array(n);
  for (i = 0; i < n; i++) out[i] = Math.max(-2048, Math.min(2047, Math.round(raw[i] / peak * PEAK)));
  return out;
}

/** The three tones the plan asks for, keyed by name. */
function tones() {
  var period = RATE / plan.TONE_HZ;
  if (period !== Math.round(period))
    throw new Error(RATE + ' Hz does not divide into whole periods of ' + plan.TONE_HZ + ' Hz');

  var out = {};
  plan.samplesUsed().forEach(function (name) { out[name] = tone(name, period, PERIODS); });
  return out;
}

// ------------------------------------------------------------------- the disk

/** What the plan asks of keygroup i, as a flat map of offset -> value. */
function wanted(spec) {
  var want = { 0: spec.key, 1: spec.key };
  Object.keys(spec.set).forEach(function (k) { want[k] = spec.set[k]; });
  return want;
}

function findProgram(disk) {
  var found = null;
  disk.programsInOrder().forEach(function (p) {
    if (p.name.trim().toUpperCase() === PROGRAM) found = p;
  });
  return found;
}

function findSample(disk, name) {
  var found = null;
  disk.entries.forEach(function (e) {
    if (e.type === 'S' && e.name.trim().toUpperCase() === name) found = e;
  });
  return found;
}

/** The whole disk, in memory: three tones and the programme the plan describes. */
function buildDisk(name, log) {
  var say = log || function () {};
  var disk = Akai.blank((name || 'LFOCAL') + '.img');
  var made = tones();
  var kgs = plan.keygroups();

  say('');
  say('building ' + PROGRAM + ': ' + Object.keys(made).length + ' tones, ' +
      kgs.length + ' keygroups');

  plan.samplesUsed().forEach(function (name) {
    var words = made[name];
    disk.addSample(name, words, RATE, plan.ROOT, 0, 'L');

    // the loop is the whole sample: the machine plays end-length..end, so an end of n
    // and a length of n is every word of it, for as long as the note is held
    var e = findSample(disk, name);
    disk.setLoop(e, words.length, words.length, 'L');

    e = findSample(disk, name);
    say('  ' + name.padEnd(6) + ' ' + words.length + ' words at ' + RATE +
        ' Hz, looping ' + e.loopLength + ' from ' + e.loopEnd);
  });

  disk.addProgram(PROGRAM);
  var prog = findProgram(disk);

  while (disk.keygroupCount(prog) < kgs.length) {
    disk.addKeygroup(prog, 0);
    prog = findProgram(disk);              // the entry moves as the file grows
  }

  kgs.forEach(function (spec, i) {
    var want = wanted(spec);
    Object.keys(want).forEach(function (k) {
      disk.setKeygroupByte(prog, i, parseInt(k, 10), want[k]);
    });
    disk.setZoneSample(prog, i, 0, spec.sample);
    prog = findProgram(disk);
  });

  return disk;
}

function build() {
  var disk = buildDisk(path.basename(target), console.log);
  var img = disk.save('img'), hfe = disk.save('hfe');
  fs.writeFileSync(target + '.img', Buffer.from(img));
  fs.writeFileSync(target + '.hfe', Buffer.from(hfe));

  console.log('');
  console.log('  ' + target + '.img  ' + img.length + ' bytes');
  console.log('  ' + target + '.hfe  ' + hfe.length + ' bytes   (for a Gotek or HxC)');
  console.log('');
  console.log('now run: node lfodisk.js check ' + target + '.img');
  console.log('');
}

// ------------------------------------------------------------------- checking

/**
 * Every way the disk could disagree with the plan.
 *
 * The same trap as the filter run: the analysis identifies a clip by its position in the
 * take, so a keygroup set to the wrong rate is not an error anyone sees. It is a wrong
 * answer, delivered confidently, after an afternoon of recording.
 */
function check() {
  var file = args[0] ? target : target + '.img';
  if (!fs.existsSync(file) && fs.existsSync(file + '.img')) file = file + '.img';
  if (!fs.existsSync(file)) {
    console.log('');
    console.log('no ' + file + ' - run: node lfodisk.js build');
    console.log('');
    return false;
  }

  var disk = Akai.load(file, new Uint8Array(fs.readFileSync(file)));
  var kgs = plan.keygroups();
  var bad = 0;

  console.log('');
  console.log(file + '  -  ' + disk.entries.length + ' files');

  // the tones, bit for bit: the analysis knows what went in, so what went in has to be
  // what this file says it is
  var made = tones();
  plan.samplesUsed().forEach(function (name) {
    var e = findSample(disk, name);
    if (!e) { console.log('  FAIL: no ' + name + ' sample'); bad++; return; }

    var want = made[name], got = disk.sampleWords12(e), differs = 0;
    if (got.length !== want.length) {
      console.log('  FAIL: ' + name + ' is ' + got.length + ' words, the plan makes ' + want.length);
      bad++;
      return;
    }
    for (var i = 0; i < want.length; i++) if (got[i] !== want[i]) differs++;

    var says = [];
    if (differs) says.push(differs + ' words differ from the generated tone');
    if (e.sampleRate !== RATE) says.push('sample rate is ' + e.sampleRate + ', not ' + RATE);
    if (e.loopMode !== 'L') says.push('loop mode is "' + e.loopMode + '", not L');
    if (e.loopEnd !== want.length || e.loopLength !== want.length)
      says.push('loops ' + e.loopLength + ' from ' + e.loopEnd + ', not the whole ' + want.length);
    if (Math.round(e.nominalPitch) !== plan.ROOT)
      says.push('root pitch is ' + e.nominalPitch + ', not ' + plan.ROOT);

    if (says.length) {
      bad += says.length;
      console.log('  ' + name);
      says.forEach(function (s) { console.log('        ' + s); });
    }
  });

  var prog = findProgram(disk);
  if (!prog) {
    console.log('  FAIL: no ' + PROGRAM + ' programme');
    console.log('');
    return false;
  }

  var raw = disk.readFile(prog);
  var count = disk.keygroupCount(prog);
  var zones = disk.keygroups(prog);

  console.log('  ' + PROGRAM + ': ' + count + ' keygroups, the plan wants ' + kgs.length);
  if (count !== kgs.length) bad++;

  kgs.forEach(function (spec, i) {
    if (i >= count) { console.log('    kg ' + (i + 1) + ' missing  -  ' + spec.why); bad++; return; }

    var want = wanted(spec);
    var says = [];

    Object.keys(want).forEach(function (k) {
      var off = parseInt(k, 10);
      var got = raw[38 + i * 70 + off];
      if (got !== want[k]) says.push(label(off) + ' is ' + got + ', the plan says ' + want[k]);
    });

    var zone = zones[i] && zones[i].zone1 ? zones[i].zone1.name.trim().toUpperCase() : '';
    if (zone !== spec.sample) says.push('zone 1 plays "' + zone + '", not ' + spec.sample);

    if (says.length) {
      bad += says.length;
      console.log('    kg ' + String(i + 1).padStart(2) + '  ' + spec.why);
      says.forEach(function (s) { console.log('          ' + s); });
    }
  });

  // no two keygroups may claim a key: two that did would both sound, and every reading
  // taken from the pair would be of two tones at once
  var owner = {};
  kgs.forEach(function (spec, i) {
    if (owner[spec.key] !== undefined) {
      console.log('    key ' + spec.key + ' is claimed by kg ' +
                  (owner[spec.key] + 1) + ' and kg ' + (i + 1));
      bad++;
    }
    owner[spec.key] = i;
  });

  // and every note the run plays has to land on one
  var missed = [];
  plan.clips().forEach(function (c) {
    [c.note, c.pairWith].forEach(function (note) {
      if (note === null || note === undefined) return;
      if (owner[note] === undefined && missed.indexOf(note) < 0) missed.push(note);
    });
  });
  if (missed.length) {
    bad += missed.length;
    console.log('    notes with no keygroup: ' + missed.join(', '));
  }

  console.log('');
  console.log(bad ? '  ' + bad + ' disagreement' + (bad === 1 ? '' : 's') +
                    ' - a take of this disk would measure something other than the plan'
                  : '  the disk matches the plan; a take of it measures what lfocal reads');
  console.log('');
  return bad === 0;
}

module.exports = { tone: tone, tones: tones, buildDisk: buildDisk, RATE: RATE,
                   PERIODS: PERIODS, HARMONICS: HARMONICS, PEAK: PEAK, DUTY: DUTY,
                   PROGRAM: PROGRAM };

if (require.main === module) {
  if (mode === 'build') build();
  else process.exit(check() ? 0 : 1);
}
