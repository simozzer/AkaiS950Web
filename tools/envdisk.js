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
  var words = noise(Math.round(SECONDS * RATE));

  say('');
  say('building ' + PROGRAM + ': ' + words.length + ' words of noise at ' + RATE +
      ' Hz, ' + kgs.length + ' keygroups');

  /*
   * Looped when the plan asks, one-shot otherwise.
   *
   * A one-shot sample caps every note at three seconds, which caps every envelope at
   * something fast, which is what made the shape of the fall unmeasurable in the first three
   * runs. Looping costs nothing - the same noise, with its loop points set - and lets a note
   * last as long as the key is held, so the envelope can be slow enough to read properly.
   */
  disk.addSample(SAMPLE, words, RATE, 60, 0, plan.LOOPING ? 'L' : 'O');

  if (plan.LOOPING) {
    // the whole sample is the loop: the machine plays end-length..end, so an end of n and a
    // length of n is every word of it, round and round
    var e = null;
    disk.entries.forEach(function (x) {
      if (x.type === 'S' && x.name.trim().toUpperCase() === SAMPLE) e = x;
    });
    if (e) disk.setLoop(e, words.length, words.length, 'L');
    say('  looped, so a note lasts as long as it is held');
  }

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

  if (!disk.entries.some(function (e) {
        return e.type === 'S' && e.name.trim().toUpperCase() === SAMPLE; })) {
    console.log('  FAIL: no ' + SAMPLE + ' sample. Every measurement divides by it.');
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
    if (zone !== SAMPLE) says.push('zone 1 plays "' + zone + '", not ' + SAMPLE);

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
