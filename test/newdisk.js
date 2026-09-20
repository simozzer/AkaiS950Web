/*
 * A disk made from nothing.
 *
 * An empty S950 disk is 800 blocks of zeros: the only structures in the reserved blocks
 * are the directory and the allocation table, and both are empty when zero. This builds
 * one, fills it, writes it in both containers and reads each back, checking at every step
 * that what comes out is a disk the sampler's own rules accept.
 *
 * It is the one test here that needs no disk images - everything it checks, it makes.
 *
 *   node test/newdisk.js
 */
var Akai = require('../akai.js');

var fails = 0;

function check(what, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? '   ' + detail : ''));
  if (!ok) fails++;
}

/* --- from nothing ----------------------------------------------------------- */

var d = Akai.blank('made-up.img');

check('a blank disk has no files', d.entries.length === 0, d.entries.length + ' entries');
check('800 blocks, four of them reserved', d.totalBlocks() === 800 && d.freeBlocks() === 796,
      d.freeBlocks() + ' free of ' + d.totalBlocks());
check('the arena starts where every library disk does', d.arenaBase() === 0xC5F6,
      '0x' + d.arenaBase().toString(16));
check('no keygroup or sample table to speak of yet',
      d.sampleTableBase() === null || d.sampleTableBase() === d.sampleTableAddress());

/* --- fill it ---------------------------------------------------------------- */

var prog = d.addProgram('NEW PROG');
check('a program can be added', d.entries.length === 1 && prog.type === 'P',
      prog ? prog.name.trim() + ', ' + prog.length + ' bytes' : 'none');

var rate = 12500, n = rate / 2;
var words = new Int16Array(n);
for (var i = 0; i < n; i++) words[i] = Math.round(900 * Math.sin(2 * Math.PI * 220 * i / rate));
d.addSample('SINE 220', words, rate, 57, 0, 'L');

var sample = d.entries.filter(function (e) { return e.type === 'S'; })[0];
check('a sample can be added', !!sample,
      sample ? sample.name.trim() + ', ' + sample.sampleCount + ' words at ' +
               sample.sampleRate + ' Hz' : 'none');

prog = d.entries.filter(function (e) { return e.type === 'P'; })[0];
d.setZoneSample(prog, 0, 0, 'SINE 220');
var kg = d.keygroups(prog)[0];
check('a keygroup can be pointed at it', kg.zone1.name.trim() === 'SINE 220',
      JSON.stringify(kg.zone1.name));

/* --- the structures the sampler relies on ----------------------------------- */

check('the directory has no holes', (function () {
  var slots = d.entries.map(function (e) { return e.slot; }).sort(function (a, b) { return a - b; });
  return slots.every(function (s, i) { return s === i; });
}()), d.entries.map(function (e) { return e.slot; }).join(','));

check('the zone pointer is the sample position', (function () {
  var want = d.sampleTableAddress() + 70 * d.sampleIndex('SINE 220');
  return kg.zone1.pointer === want;
}()), '0x' + kg.zone1.pointer.toString(16));

check("the program header restates its own layout", (function () {
  var body = d.readFile(prog);
  return body[23] === d.keygroupCount(prog) &&
         (body[18] | (body[19] << 8)) === d.arenaBase();
}()), 'count ' + d.readFile(prog)[23]);

check('the sample chain is as long as the file needs', (function () {
  return d.chain(sample.startBlock).length === Math.ceil(sample.length / 1024);
}()), sample.chainBlocks + ' blocks');

/* --- write it, read it back ------------------------------------------------- */

['img', 'hfe'].forEach(function (fmt) {
  var bytes = d.save(fmt);
  var again = Akai.load('again.' + fmt, bytes);

  check('written as .' + fmt + ' and read back', again.entries.length === d.entries.length,
        (bytes.length / 1024).toFixed(0) + ' KB, ' + again.entries.length + ' files');

  var s2 = again.entries.filter(function (e) { return e.type === 'S'; })[0];
  check('  the audio survives the round trip', (function () {
    var out = again.sampleWords12(s2);
    if (out.length !== words.length) return false;
    for (var j = 0; j < out.length; j++) if (out[j] !== words[j]) return false;
    return true;
  }()), s2 ? s2.sampleCount + ' words' : 'no sample');

  check('  and the zone still names it',
        again.keygroups(again.entries.filter(function (e) { return e.type === 'P'; })[0])[0]
             .zone1.name.trim() === 'SINE 220');
});

console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);
