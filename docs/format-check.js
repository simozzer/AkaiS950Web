/*
 * Checks the claims in S950-Disk-Format.html against the disk library.
 *
 * The document is largely numbers taken from a corpus - "non-zero in 200 of 1110 samples",
 * "255 in all 341 S900 programs" - and numbers age. This recounts them, so a claim that
 * has drifted says so instead of sitting there looking authoritative.
 *
 *   node docs/format-check.js <directory of .hfe>
 *
 * Every claim names the section it comes from. A FAIL is the document being wrong about
 * the library, not the library being wrong.
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');

var dir = process.argv[2] || 'C:\\Users\\simon\\AkaiS950Images';

/* ------------------------------------------------------------- gather the facts */

var disks = [], samples = [], programs = [], keygroups = [];

// The document is explicit about this: figures given "of 1899" exclude DSKA0049, the
// one image whose contents differ between the author's two sticks; those given "of
// 1908" cover every keygroup on both. A checker that ignores the distinction reports
// nine phantom errors, which is how this one started out.
var EXCLUDED = 'DSKA0049';
function onTheStick(x) { return x.disk.name.indexOf(EXCLUDED) < 0; }

fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); }).sort().forEach(function (f) {
  var d;
  try { d = Akai.load(f, new Uint8Array(fs.readFileSync(path.join(dir, f)))); }
  catch (e) { return; }
  disks.push(d);

  d.entries.forEach(function (e) {
    if (e.type === 'S') samples.push({ disk: d, e: e, body: d.readFile(e) });
    else if (e.type === 'P') {
      var body = d.readFile(e);
      programs.push({ disk: d, e: e, body: body });
      d.keygroups(e).forEach(function (kg) { keygroups.push({ disk: d, p: e, kg: kg }); });
    }
  });
});

/* ------------------------------------------------------------------- the claims */

var results = [];

function claim(section, text, got, want) {
  var ok = String(got) === String(want);
  results.push({ section: section, text: text, got: got, want: want, ok: ok });
}

function count(list, test) {
  var n = 0;
  list.forEach(function (x) { if (test(x)) n++; });
  return n;
}

function loopRecords(words, mode) {
  var pages = Math.floor(2 * words / 131072);
  return mode === 'L' ? 3 + pages : mode === 'A' ? 3 * (1 + pages) : 2 + pages;
}

// --- the corpus itself
claim('1', 'the library is 101 disks', disks.length, 101);
claim('6', 'it holds 1,110 samples', samples.length, 1110);
claim('7', 'it holds 390 programs', programs.length, 390);
claim('7', 'it holds 1,908 keygroups', keygroups.length, 1908);

// --- 6.1 the sample header
claim('6.1', 'name padding is zero on all but 13 samples',
  count(samples, function (s) {
    for (var i = 0x0A; i < 0x10; i++) if (s.body[i] !== 0) return true;
    return false;
  }), 13);

claim('6.1', 'loudness at 0x18 is non-zero on 200 samples',
  count(samples, function (s) { return ((s.body[0x18] | (s.body[0x19] << 8)) << 16 >> 16) !== 0; }), 200);

var loud = samples.map(function (s) { return (s.body[0x18] | (s.body[0x19] << 8)) << 16 >> 16; });
claim('6.1', 'loudness spans -31..+50',
  Math.min.apply(null, loud) + '..' + Math.max.apply(null, loud), '-31..50');

claim('6.1', 'fine pitch is non-zero on 71 samples',
  count(samples, function (s) { return (s.e.tuning % 16) !== 0; }), 71);

var nominal = samples.map(function (s) { return Math.floor(s.e.tuning / 16); });
claim('6.1', 'nominal pitch spans MIDI 24..96',
  Math.min.apply(null, nominal) + '..' + Math.max.apply(null, nominal), '24..96');

claim('6.1', 'only one sample is reverse-looped',
  count(samples, function (s) { return s.e.loopDirection === 'R'; }), 1);

// --- 6.1 how the three loop fields combine
var looped = samples.filter(function (s) { return s.e.loopMode !== 'O'; });
claim('6.1', '324 samples carry a loop', looped.length, 324);
claim('6.1', 'the start marker is 0 on 250 of them',
  count(looped, function (s) { return s.e.loopStart === 0; }), 250);
claim('6.1', 'and equals end - length on only 8',
  count(looped, function (s) { return s.e.loopStart === s.e.loopEnd - s.e.loopLength; }), 8);
claim('6.1', 'the end marker is the sample length on 208 of 324',
  count(looped, function (s) { return s.e.loopEnd === s.e.sampleCount; }), 208);
claim('6.1', '30 stop short of it by more than 50 ms',
  count(looped, function (s) {
    return (s.e.sampleCount - s.e.loopEnd) / s.e.sampleRate > 0.05;
  }), 30);
claim('6.1', 'no loop reaches back past the start of the data',
  count(looped, function (s) { return s.e.loopEnd - s.e.loopLength < 0; }), 0);

// --- 6.1 the loop descriptor table
claim('6.1', "every disk's first sample points at 0xB6F4",
  count(disks, function (d) {
    var ss = d.entries.filter(function (e) { return e.type === 'S'; })
                      .sort(function (a, b) { return a.slot - b.slot; });
    return ss.length > 0 && ss[0].loopDescriptorPtr === 0xB6F4;
  }), disks.filter(function (d) {
    return d.entries.some(function (e) { return e.type === 'S'; });
  }).length);

var fit = { O: [0, 0], L: [0, 0], A: [0, 0] };
disks.forEach(function (d) {
  var ss = d.entries.filter(function (e) { return e.type === 'S'; })
                    .sort(function (a, b) { return a.slot - b.slot; });
  for (var i = 1; i < ss.length; i++) {
    var p = ss[i - 1], mode = 'OLA'.indexOf(p.loopMode) >= 0 ? p.loopMode : 'O';
    var want = p.loopDescriptorPtr + 10 * loopRecords(p.sampleCount, p.loopMode);
    fit[mode][1]++;
    if (ss[i].loopDescriptorPtr === want) fit[mode][0]++;
  }
});
claim('6.1', 'one-shot: 2 + f records, fitting 723 of 725', fit.O.join(' of '), '723 of 725');
claim('6.1', 'looping: 3 + f records, fitting 267 of 270', fit.L.join(' of '), '267 of 270');
claim('6.1', 'alternating: 3 x (1 + f) records, fitting 12 of 16', fit.A.join(' of '), '12 of 16');

// --- 6.1 the RAM chain
var ramPairs = 0, ramOk = 0;
disks.forEach(function (d) {
  var ss = d.entries.filter(function (e) { return e.type === 'S'; })
                    .sort(function (a, b) { return a.slot - b.slot; });
  for (var i = 1; i < ss.length; i++) {
    ramPairs++;
    var size = Math.floor((2 * ss[i - 1].sampleCount + 15) / 16) * 16;
    if (ss[i].memoryAddress === ss[i - 1].memoryAddress + size) ramOk++;
  }
});
claim('6.1', 'RAM addresses follow in 1,011 of 1,011 consecutive pairs',
  ramOk + ' of ' + ramPairs, '1011 of 1011');

// --- 6.2 the file length rule
claim('6.2', 'a sample file is 60 + 1.5N bytes, on all 1,110',
  count(samples, function (s) { return s.e.length === 60 + 1.5 * s.e.sampleCount; }), 1110);

// --- 7.1 the program header
claim('7.1', 'the format marker at 22 is 255 on 341 S900 programs',
  count(programs, function (p) { return p.body[22] === 255; }), 341);
claim('7.1', 'and 0 on 49 S950 programs',
  count(programs, function (p) { return p.body[22] === 0; }), 49);
claim('7.1', 'byte 20 is constant 0, on all 390',
  count(programs, function (p) { return p.body[20] === 0; }), 390);
claim('7.1', 'the keygroup count matches the file length in 390 of 390',
  count(programs, function (p) {
    return p.e.length === 38 + 70 * p.body[23];
  }), 390);
claim('7.1', 'byte 27 is 255 in 388 of 390',
  count(programs, function (p) { return p.body[27] === 255; }), 388);

// --- 7.3 the keygroup header
claim('7.3', 'bit 0 of byte 18, constant pitch, is set on 481 keygroups',
  count(keygroups, function (k) { return (k.kg.raw[18] & 1) !== 0; }), 481);
claim('7.3', 'bit 2, LFO desync, is set on 1,652',
  count(keygroups, function (k) { return (k.kg.raw[18] & 4) !== 0; }), 1652);
claim('7.3', 'LFO depth to modwheel (22) differs from its default 50 on 427',
  count(keygroups, function (k) { return k.kg.raw[22] !== 50; }), 427);
claim('7.3', 'LFO depth to aftertouch (21) is 0 on all 1,908',
  count(keygroups, function (k) { return k.kg.raw[21] === 0; }), 1908);

// "of 1899" - DSKA0049 left out, as the document says
claim('7.3', 'velocity to release (10) is non-zero on 20 of 1,899',
  count(keygroups.filter(onTheStick), function (k) {
    return ((k.kg.raw[10] << 24) >> 24) !== 0;
  }), 20);

var rel = keygroups.map(function (k) { return (k.kg.raw[10] << 24) >> 24; });
claim('7.3', 'velocity to release spans exactly -50..+50',
  Math.min.apply(null, rel) + '..' + Math.max.apply(null, rel), '-50..50');

// --- 7.5 the zones
function namesASecondSample(k) {
  var nm = (k.kg.zone2.name || '').trim();
  return nm !== '' && nm !== '2 SAMPLE';
}
claim('7.5', '266 of 1,899 keygroups name a second sample',
  count(keygroups.filter(onTheStick), namesASecondSample), 266);
claim('7.5', '45 of those carry a threshold of 60-116',
  count(keygroups.filter(onTheStick), function (k) {
    return namesASecondSample(k) && k.kg.raw[2] >= 60 && k.kg.raw[2] <= 116;
  }), 45);
claim('7.5', 'the other 221 sit at 128, leaving zone 2 silent',
  count(keygroups.filter(onTheStick), function (k) {
    return namesASecondSample(k) && k.kg.raw[2] === 128;
  }), 221);
claim('7.5', '1,633 name none, and not one of them is anything but 128',
  count(keygroups.filter(onTheStick), function (k) {
    return !namesASecondSample(k) && k.kg.raw[2] === 128;
  }), 1633);

// --- 7.6 the output byte
claim('7.6', 'byte 19 is 0xFF on 1,608 of 1,899 keygroups',
  count(keygroups.filter(onTheStick), function (k) { return k.kg.raw[19] === 0xFF; }), 1608);

/* ------------------------------------------------------------------- the report */

var bad = results.filter(function (r) { return !r.ok; });
console.log(disks.length + ' disks, ' + samples.length + ' samples, ' + programs.length +
            ' programs, ' + keygroups.length + ' keygroups');
console.log(results.length + ' claims checked, ' + bad.length + ' no longer true\n');

results.forEach(function (r) {
  console.log((r.ok ? '  ok   ' : '  FAIL ') + '§' + r.section + '  ' + r.text +
              (r.ok ? '' : '   -  document says ' + r.want + ', the library says ' + r.got));
});

process.exit(bad.length ? 1 : 0);
