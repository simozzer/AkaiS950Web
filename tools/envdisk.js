/*
 * Build - or check - the ENVCAL disk, from nothing.
 *
 *   node envdisk.js build [name]      writes name.img and name.hfe
 *   node envdisk.js check <image>     reads one back and holds it to envplan.js
 *
 * The disk carries one sample and one programme, both derived from envplan.js, so it is
 * rebuilt rather than kept: a disk in the repo would be a second copy of the plan that
 * could disagree with it silently.
 *
 * WHY NOISE
 *
 * Every measurement here is a -3 dB corner, and a corner can only be found in a source that
 * has something at every frequency to take away. White noise has exactly that and nothing
 * else - no harmonic structure to be mistaken for a filter slope, no pitch to move with the
 * key. The analysis divides the take by this sample's own spectrum, read off the disk, so
 * whatever the recording chain does cancels along with whatever the noise happens to be.
 *
 * It is generated from a fixed seed, so two people building this disk get the same bytes
 * and the same answers.
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');
/*
 * Which run this is for.
 *
 * --plan envplan2.js points the tool at the second run. Without it the first one is used,
 * and that matters: a take already recorded has to stay analysable after the plan has moved
 * on, or the recording becomes the only copy of what it measured.
 */
var args = process.argv.slice(2);
var planFile = './envplan.js';
for (var ai = 0; ai < args.length; ai++) {
  if (args[ai] === '--plan') { planFile = './' + args[ai + 1].split(/[/]/).pop(); args.splice(ai, 2); break; }
}
var plan = require(planFile);

var mode = (args[0] === 'build' || args[0] === 'check') ? args.shift() : 'check';
var target = args[0] || path.join(__dirname, 'ENVCAL');

var PROGRAM = 'ENVCAL';
var SAMPLE = 'NOISE';

/*
 * 44.1 kHz so the filter's ceiling sits where the original calibration put it - 0.37 of the
 * rate, 16.3 kHz - and the two runs can be read against each other.
 */
var RATE = 44100;
var SECONDS = 3.0;
var PEAK = 1500;             // of the 12-bit +-2047, leaving room for the filter to ring

var NAMES = {
  3: 'VCA attack', 4: 'VCA decay', 5: 'VCA sustain', 6: 'VCA release',
  7: 'vel->filter', 8: 'key->filter', 11: 'vel->loudness', 18: 'flags',
  23: 'VCF amount',
  34: 'VCF attack', 35: 'VCF decay', 36: 'VCF sustain', 37: 'VCF release',
  43: 'transpose', 44: 'zone 1 filter', 45: 'zone 1 loudness'
};

function label(off) { return NAMES[off] ? NAMES[off] + ' (' + off + ')' : 'byte ' + off; }

/*
 * White noise from a fixed seed.
 *
 * A plain linear congruential generator, because the numbers only have to be the same every
 * time and flat across the band - which any of them is. Averaged to zero so the sample
 * carries no offset for the filter to settle through at the start of every note.
 */
function noise(count) {
  var words = new Int16Array(count);
  var seed = 0x13579BDF;
  var sum = 0;

  for (var i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
    var v = Math.round(((seed / 0x40000000) - 1) * PEAK);
    words[i] = v;
    sum += v;
  }

  var bias = Math.round(sum / count);
  if (bias !== 0) for (var j = 0; j < count; j++) words[j] -= bias;
  return words;
}

/*
 * A pure tone, for a run that needs two samples telling apart rather than one measured.
 *
 * Noise is the right source for a filter measurement - something at every frequency to take
 * away - and exactly the wrong one for "which of these two samples am I hearing", because two
 * pieces of noise sound alike. A sine against noise is the easiest pair there is: one has all
 * its energy in a single bin and the other has none to speak of in any.
 *
 * Whole cycles in the buffer, so a looping sample joins to itself without a click that would
 * put a spray of harmonics into the very measurement it is there to make clean.
 */
function tone(count, hz, rate) {
  var cycles = Math.max(1, Math.round(count * hz / rate));
  var words = new Int16Array(count);

  for (var i = 0; i < count; i++)
    words[i] = Math.round(Math.sin(2 * Math.PI * cycles * i / count) * PEAK);

  return words;
}

/*
 * What a plan wants on its disk.
 *
 * Most runs want the one noise sample and say nothing, which is what SAMPLES defaulting to
 * that gives them. A run that needs to tell two samples apart names both and says what each
 * should be.
 */
function samplesFor(plan) {
  if (plan.SAMPLES && plan.SAMPLES.length) return plan.SAMPLES;
  return [{ name: SAMPLE, kind: 'noise' }];
}

/*
 * A sawtooth of a given period in FRAMES, for measuring what a loop does with its own ends.
 *
 * Deliberately asymmetric, which is the whole point. A loop that alternates plays its frames
 * forward and then backward, and a symmetric waveform reversed is the same waveform - so a
 * sine would sound identical either way and measure nothing. A ramp reversed is the other
 * ramp, and a loop that alternates therefore turns a sawtooth into a TRIANGLE at half the
 * frequency, which the pitch analysis reads off in one number:
 *
 *     forward only                    saw       at rate / period
 *     alternating, ends repeated      triangle  at rate / (2 * period)
 *     alternating, ends played once   triangle  at rate / (2 * period - 2)
 *
 * The period is in frames rather than hertz because the question is about frame counts: two
 * frames in a loop of twenty is a tenth of the pitch, and stating it as a frequency would
 * round the very thing being measured.
 */
function ramp(count, period) {
  var words = new Int16Array(count);
  var p = Math.max(2, Math.round(period));

  for (var i = 0; i < count; i++) {
    // -PEAK at the first frame of each period, climbing to nearly +PEAK at the last
    var phase = (i % p) / p;
    words[i] = Math.round((phase * 2 - 1) * PEAK);
  }

  return words;
}

/*
 * Two tones, one after the other, for telling forwards from backwards.
 *
 * Reverse playback cannot be measured with a ramp or a sine: a sawtooth played backwards is
 * the mirrored sawtooth and a sine is a sine, and both have exactly the period they started
 * with. What a reversal changes is the ORDER of things, so the source has to have an order -
 * low then high, which the pitch trace reads as a step up or a step down and nothing else can
 * be mistaken for.
 *
 * Whole cycles in each half, so neither the join in the middle nor the loop back to the start
 * puts a click where a measurement is being taken.
 */
function twoTone(count, lowHz, highHz) {
  var half = Math.floor(count / 2);
  var words = new Int16Array(count);

  [[0, half, lowHz], [half, count, highHz]].forEach(function (part) {
    var from = part[0], to = part[1], n = to - from;
    var cycles = Math.max(1, Math.round(n * part[2] / RATE));

    for (var i = 0; i < n; i++)
      words[from + i] = Math.round(Math.sin(2 * Math.PI * cycles * i / n) * PEAK);
  });

  return words;
}

/*
 * A struck note: a tone under a sharp attack and a long decay.
 *
 * The one source that tells forwards from backwards without any argument. A reversal changes
 * the ORDER of things, and the strongest order a real sample has is its own envelope - played
 * as recorded this hits and fades, played backwards it swells and stops dead. That is how a
 * reversed cymbal sounds and it is what the level trace reads straight off.
 *
 * Run 13 asked the same question with two sustained tones at a flat level and learned less
 * than it should have: a flat sample has no envelope to reverse, which threw away the best
 * detector there is before the recording started.
 */
function perc(count, hz, tau) {
  var words = new Int16Array(count);
  var t = Math.max(0.005, tau || 0.08);
  var cycles = Math.max(1, Math.round(count * hz / RATE));

  for (var i = 0; i < count; i++) {
    var env = Math.exp(-(i / RATE) / t);
    words[i] = Math.round(Math.sin(2 * Math.PI * cycles * i / count) * env * PEAK);
  }

  return words;
}

function wordsFor(spec, count) {
  if (spec.kind === 'ramp')    return ramp(count, spec.period || 50);
  if (spec.kind === 'twotone') return twoTone(count, spec.lowHz || 500, spec.highHz || 1500);
  if (spec.kind === 'perc')    return perc(count, spec.hz || 1000, spec.tau);
  return spec.kind === 'tone' ? tone(count, spec.hz || 1000, RATE) : noise(count);
}

function findProgram(disk) {
  var found = null;
  disk.programsInOrder().forEach(function (p) {
    if (p.name.trim().toUpperCase() === PROGRAM) found = p;
  });
  return found;
}

/** What the plan asks of one keygroup, as a flat map of offset -> value. */
function wanted(spec) {
  var want = { 0: spec.high, 1: spec.low };
  Object.keys(spec.set).forEach(function (k) { want[k] = spec.set[k]; });
  return want;
}

function buildDisk(name, log) {
  var say = log || function () {};
  var disk = Akai.blank((name || PROGRAM) + '.img');
  var kgs = plan.keygroups();
  var specs = samplesFor(plan);
  var count = Math.round(SECONDS * RATE);

  say('');
  say('building ' + PROGRAM + ': ' + specs.length + ' sample(s) of ' + count +
      ' words at ' + RATE + ' Hz, ' + kgs.length + ' keygroups');

  /*
   * Looped when the plan asks, one-shot otherwise.
   *
   * A one-shot sample caps every note at three seconds, which caps every envelope at
   * something fast, which is what made the shape of the fall unmeasurable in the first three
   * runs. Looping costs nothing - the same noise, with its loop points set - and lets a note
   * last as long as the key is held, so the envelope can be slow enough to read properly.
   */
  specs.forEach(function (spec) {
    /*
     * A sample may ask for its own length.
     *
     * The default is three seconds, which is what a run needs when the sample IS the sound
     * being measured and a note has to last. Run 13 measures what the LOOP does, so all it
     * needs is enough sample to hold one, and six three-second samples do not fit on a floppy
     * - the first one alone wanted 194 blocks of the 200 there are.
     */
    var words = wordsFor(spec, spec.frames || count);

    /*
     * A sample may name its own loop mode and length, or take the plan's.
     *
     * Every run up to the twelfth wanted one thing of its loops - that a note last as long as
     * the key is held - so plan.LOOPING said 'L' or 'O' for all of them and the loop was the
     * whole sample. Run 13 asks what the loop DOES, which needs 'A' on some samples and not
     * others, and a loop of twenty frames inside a sample of a hundred thousand.
     *
     * So spec.loopMode and spec.loopLength win where they are given, and where they are not
     * the old behaviour is exactly what happens.
     */
    var mode = spec.loopMode || (plan.LOOPING ? 'L' : 'O');
    var loopLen = spec.loopLength || words.length;

    disk.addSample(spec.name, words, RATE, 60, 0, mode);

    say('  ' + spec.name + ': ' +
        (spec.kind === 'tone'    ? (spec.hz || 1000) + ' Hz tone'
       : spec.kind === 'ramp'    ? 'sawtooth, ' + (spec.period || 50) + ' frames a cycle'
       : spec.kind === 'twotone' ? (spec.lowHz || 500) + ' Hz then ' +
                                   (spec.highHz || 1500) + ' Hz'
       : spec.kind === 'perc'    ? (spec.hz || 1000) + ' Hz struck, decaying over ' +
                                   ((spec.tau || 0.08) * 1000).toFixed(0) + ' ms'
       :                           'white noise from a fixed seed') +
        (mode === 'O' ? '' : '   loop ' + loopLen + ' frames, ' +
          (mode === 'A' ? 'ALTERNATING' : 'forward')));

    var entry = null;
    disk.entries.forEach(function (x) {
      if (x.type === 'S' && x.name.trim().toUpperCase() === spec.name.toUpperCase()) entry = x;
    });

    if (mode !== 'O' && entry) {
      // the machine plays end-length..end, so an end of n with a length of n is the whole
      // sample round and round, and a shorter length is the tail of it
      disk.setLoop(entry, words.length, loopLen, mode);
    }

    /*
     * Time direction, header byte 0x2B: 'N' normal, 'R' reverse.
     *
     * addSample writes 'N' and has no way to say otherwise, which was right while nothing
     * needed the other one - exactly one sample in the 1110 on the real disks is 'R'. Poked
     * here rather than threaded through addSample's arguments, because it is a single byte
     * of an otherwise finished header and the list of arguments is long enough.
     */
    if (spec.direction === 'R' && entry) {
      disk.pokeFile(entry, 0x2B, 'R'.charCodeAt(0));
      say('    played in REVERSE');
    }
  });

  if (plan.LOOPING) say('  looped, so a note lasts as long as it is held');

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

    // A second zone, for a run measuring which of the two a strike reaches. Everything
    // before run 6 names one sample and leaves zone 2 as the panel left it.
    if (spec.sample2) disk.setZoneSample(prog, i, 1, spec.sample2);

    prog = findProgram(disk);
  });

  /*
   * Anything the plan wants in the programme's own 38-byte header.
   *
   * Every run before the fifteenth cared only about keygroups, so nothing here could reach
   * the header at all. Run 15 needs byte 21, the positional crossfade, which is a property of
   * the PROGRAMME rather than of any keygroup - and header bytes are poked by offset the same
   * way keygroup bytes are, so the plan states them the same way.
   */
  if (plan.HEADER) {
    Object.keys(plan.HEADER).forEach(function (k) {
      disk.pokeFile(prog, parseInt(k, 10), plan.HEADER[k]);
    });
    prog = findProgram(disk);
  }

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
  console.log('now run: node envdisk.js check ' + target + '.img');
  console.log('');
}

function check() {
  var file = target;
  if (!fs.existsSync(file)) {
    console.log('no such image: ' + file);
    process.exit(1);
  }

  var disk = Akai.load(file, new Uint8Array(fs.readFileSync(file)));
  var prog = findProgram(disk);
  var kgs = plan.keygroups();
  var bad = 0;

  console.log('');
  console.log(file + '  -  ' + disk.entries.length + ' files');

  var missing = samplesFor(plan).filter(function (s) {
    return !disk.entries.some(function (e) {
      return e.type === 'S' && e.name.trim().toUpperCase() === s.name.toUpperCase(); });
  });

  if (missing.length) {
    console.log('  FAIL: no ' + missing.map(function (s) { return s.name; }).join(', ') +
                ' sample. Every measurement divides by it.');
    process.exit(1);
  }

  if (!prog) {
    console.log('  FAIL: no ' + PROGRAM + ' programme.');
    process.exit(1);
  }

  var raw = disk.readFile(prog);
  var count = disk.keygroupCount(prog);
  var live = disk.keygroups(prog);

  console.log('  ' + PROGRAM + ': ' + count + ' keygroups, the plan wants ' + kgs.length);
  if (count !== kgs.length) bad++;

  kgs.forEach(function (spec, i) {
    if (i >= count) { console.log('    kg ' + (i + 1) + ' missing'); bad++; return; }

    var want = wanted(spec);
    var says = [];

    Object.keys(want).forEach(function (k) {
      var off = parseInt(k, 10);
      var got = raw[38 + i * 70 + off];
      if (got !== want[k]) says.push(label(off) + ' is ' + got + ', the plan says ' + want[k]);
    });

    var zone = live[i] && live[i].zone1 ? live[i].zone1.name.trim().toUpperCase() : '';
    if (zone !== spec.sample.toUpperCase())
      says.push('zone 1 plays "' + zone + '", not ' + spec.sample);

    /*
     * A second zone that did not take is the whole of run 6 measuring nothing.
     *
     * It has to be there AND the keygroup has to agree it is in use - a name alone is not
     * enough, since the panel leaves "2 SAMPLE" and a null pointer in a zone it is not
     * using, and the engines read those as no second zone at all.
     */
    if (spec.sample2) {
      var z2 = live[i] && live[i].zone2;
      var got2 = z2 ? z2.name.trim().toUpperCase() : '';

      if (got2 !== spec.sample2.toUpperCase())
        says.push('zone 2 plays "' + got2 + '", not ' + spec.sample2);
      else if (!z2.inUse)
        says.push('zone 2 names ' + spec.sample2 + ' but does not read as in use');
    }

    if (says.length) {
      bad += says.length;
      console.log('    kg ' + String(i + 1).padStart(2) + '  ' + spec.why);
      says.forEach(function (s) { console.log('          ' + s); });
    }
  });

  // every note the run plays has to land somewhere
  var missed = [];
  plan.clips().forEach(function (c) {
    var hit = live.some(function (kg) {
      return c.note >= Math.min(kg.lowKey, kg.highKey) &&
             c.note <= Math.max(kg.lowKey, kg.highKey);
    });
    if (!hit && missed.indexOf(c.note) < 0) missed.push(c.note);
  });
  if (missed.length) { bad += missed.length; console.log('    notes with no keygroup: ' + missed.join(', ')); }

  console.log('');
  console.log(bad ? '  ' + bad + ' disagreement' + (bad === 1 ? '' : 's')
                  : '  the disk matches the plan');
  console.log('');
  process.exit(bad ? 1 : 0);
}

if (require.main === module) { if (mode === 'build') build(); else check(); }

module.exports = { buildDisk: buildDisk, noise: noise, RATE: RATE, SECONDS: SECONDS,
                   PROGRAM: PROGRAM, SAMPLE: SAMPLE };
