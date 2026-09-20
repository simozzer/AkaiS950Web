/*
 * Check - or rebuild - the CALIB programme against benchplan.js.
 *
 *   node benchdisk.js [check] [image]
 *   node benchdisk.js build <in.hfe> <out.hfe>
 *
 * benchplan.js describes the keygroups the calibration run needs, but until now nothing
 * connected that description to the disk: CALIB was built once by hand and the plan was
 * written alongside it. Either could drift, and a drifted disk fails silently - benchcal
 * identifies each clip by its position in the run, so a keygroup set to the wrong filter
 * is not an error, it is a wrong answer delivered confidently.
 *
 * This closes that. `check` reads the disk and reports every byte the plan names that
 * does not hold what the plan says. `build` writes the programme the plan describes.
 *
 * Only the bytes the plan names are compared. Everything else is whatever the programme
 * was seeded from, and the tests do not depend on it.
 */
var fs = require('fs');
var Akai = require('../akai.js');
var plan = require('./benchplan.js');

var args = process.argv.slice(2);
var mode = (args[0] === 'build' || args[0] === 'check') ? args.shift() : 'check';
var image = args[0] || 'DSKA0000-bench.hfe';
var outFile = args[1];

var SAMPLE = 'NOISE';
var PROGRAM = 'CALIB';

// keygroup byte offsets worth naming in a report
var NAMES = {
  0: 'high key', 1: 'low key',
  3: 'VCA attack', 4: 'VCA decay', 5: 'VCA sustain', 6: 'VCA release',
  7: 'vel->filter', 8: 'key->filter', 9: 'vel->attack', 11: 'vel->loudness',
  23: 'VCF amount',
  34: 'VCF attack', 35: 'VCF decay', 36: 'VCF sustain', 37: 'VCF release',
  44: 'zone 1 filter', 45: 'zone 1 loudness'
};

function label(off) { return NAMES[off] ? NAMES[off] + ' (' + off + ')' : 'byte ' + off; }

function open(file) {
  return Akai.load(file, new Uint8Array(fs.readFileSync(file)));
}

function findProgram(disk) {
  var found = null;
  disk.programsInOrder().forEach(function (p) {
    if (p.name.trim().toUpperCase() === PROGRAM) found = p;
  });
  return found;
}

/** What the plan asks of keygroup i, as a flat map of offset -> value. */
function wanted(spec) {
  var want = { 0: spec.high, 1: spec.low };
  Object.keys(spec.set).forEach(function (k) { want[k] = spec.set[k]; });
  return want;
}

// ---------------------------------------------------------------------- check

function check() {
  var disk = open(image);
  var prog = findProgram(disk);

  console.log('');
  console.log(image + '  -  ' + disk.entries.length + ' files');

  if (!disk.entries.some(function (e) { return e.type === 'S' && e.name.trim().toUpperCase() === SAMPLE; })) {
    console.log('  FAIL: no ' + SAMPLE + ' sample. Every measurement divides by it.');
    return false;
  }
  if (!prog) {
    console.log('  FAIL: no ' + PROGRAM + ' programme. Run: node benchdisk.js build ' +
                image + ' <out.hfe>');
    return false;
  }

  var raw = disk.readFile(prog);
  var count = disk.keygroupCount(prog);
  var kgs = disk.keygroups(prog);
  var bad = 0;

  console.log('  ' + PROGRAM + ': ' + count + ' keygroups, the plan wants ' + plan.KEYGROUPS.length);
  if (count !== plan.KEYGROUPS.length) bad++;

  plan.KEYGROUPS.forEach(function (spec, i) {
    if (i >= count) { console.log('    kg ' + (i + 1) + ' missing  -  ' + spec.why); bad++; return; }

    var want = wanted(spec);
    var says = [];

    Object.keys(want).forEach(function (k) {
      var off = parseInt(k, 10);
      var got = raw[38 + i * 70 + off];
      if (got !== want[k]) {
        says.push(label(off) + ' is ' + got + ', the plan says ' + want[k]);
      }
    });

    var zone = kgs[i] && kgs[i].zone1 ? kgs[i].zone1.name.trim().toUpperCase() : '';
    if (zone !== SAMPLE) says.push('zone 1 plays "' + zone + '", not ' + SAMPLE);

    if (says.length) {
      bad += says.length;
      console.log('    kg ' + String(i + 1).padStart(2) + '  ' + spec.why);
      says.forEach(function (s) { console.log('          ' + s); });
    }
  });

  // the notes the run actually plays have to land somewhere
  var missed = [];
  plan.clips().forEach(function (c) {
    var hit = kgs.some(function (kg) {
      return c.note >= Math.min(kg.lowKey, kg.highKey) && c.note <= Math.max(kg.lowKey, kg.highKey);
    });
    if (!hit && missed.indexOf(c.note) < 0) missed.push(c.note);
  });
  if (missed.length) {
    bad += missed.length;
    console.log('    notes with no keygroup: ' + missed.join(', '));
  }

  console.log('');
  console.log(bad ? '  ' + bad + ' disagreement' + (bad === 1 ? '' : 's') +
                    ' - the take would measure something other than the plan'
                  : '  the disk matches the plan; a take of it measures what benchcal thinks');
  console.log('');
  return bad === 0;
}

// ---------------------------------------------------------------------- build

function build() {
  if (!outFile) {
    console.log('build needs an output file: node benchdisk.js build ' + image + ' out.hfe');
    process.exit(1);
  }

  var disk = open(image);
  var existing = findProgram(disk);
  if (existing) { disk.deleteProgram(existing); disk.parseDirectory(); }

  disk.addProgram(PROGRAM);
  var prog = findProgram(disk);

  while (disk.keygroupCount(prog) < plan.KEYGROUPS.length) {
    disk.addKeygroup(prog, 0);
    prog = findProgram(prog && disk);       // the entry moves as the file grows
  }

  plan.KEYGROUPS.forEach(function (spec, i) {
    var want = wanted(spec);
    Object.keys(want).forEach(function (k) {
      disk.setKeygroupByte(prog, i, parseInt(k, 10), want[k]);
    });
    disk.setZoneSample(prog, i, 0, SAMPLE);
  });

  fs.writeFileSync(outFile, Buffer.from(disk.save('hfe')));
  console.log('');
  console.log('wrote ' + outFile + ' with ' + PROGRAM + ', ' +
              plan.KEYGROUPS.length + ' keygroups');
  console.log('now run: node benchdisk.js check ' + outFile);
  console.log('');
}

if (mode === 'build') build();
else process.exit(check() ? 0 : 1);
