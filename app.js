/*
 * Akai S950 Studio - browser front end. All the format work is in akai.js;
 * this is the tree, the canvases, the editors and Web Audio.
 */
(function () {
  'use strict';

  var disks = [];
  var sel = null;              // { disk, entry }
  var selKeygroup = -1;       // the lead: the one the editor and the keyboard show
  var selSet = [];            // every selected keygroup, in list order, lead included
  var selAnchor = -1;         // where a shift-click measures its run from
  var hoverNote = -1;
  var spans = [];
  // Setting a key range by typing two MIDI numbers means knowing them. The button
  // beside the Key range heading arms the keyboard instead: the next click is the
  // low key, the one after it the high, and the same key twice is a one-key group.
  var setRange = { on: false, kg: -1, low: -1 };
  var waveWords = null, waveEntry = null, waveEnv = null, waveWidth = -1;
  var openState = {};          // which tree nodes are open, kept across rebuilds

  var $ = function (id) { return document.getElementById(id); };
  // Voices are keyed - by MIDI note when played from a sequencer, by the string
  // "preview" for the button and the on-screen keyboard - so a note-off releases the
  // note it belongs to and nothing else. The S950 has eight, and so does this.
  var audio = null, voices = {}, voiceSeq = 0;
  var MAX_VOICES = 8;

  /**
   * What a note must not pay for.
   *
   * Every MIDI note used to re-walk the FAT for the program, rebuild every keygroup
   * object from the file, and unpack the whole sample again - work that only changes
   * when the image does. All three are pure functions of the image, so they are kept
   * until `generation` says the image moved under them.
   *
   * The audio buffer is cached with them, but only for the unfiltered path: with the
   * filter on, the samples depend on the note and the velocity and are different every
   * time.
   */
  var derived = { disk: null, gen: -1, words: {}, kgs: {}, buffers: {} };

  function derivedFor(d) {
    if (derived.disk !== d || derived.gen !== d.generation) {
      derived.disk = d;
      derived.gen = d.generation;
      derived.words = {};
      derived.kgs = {};
      derived.buffers = {};
    }
    return derived;
  }

  function wordsOf(d, e) {
    var c = derivedFor(d);
    if (!c.words[e.slot]) c.words[e.slot] = d.sampleWords12(e);
    return c.words[e.slot];
  }

  function keygroupsOf(d, p) {
    var c = derivedFor(d);
    if (!c.kgs[p.slot]) c.kgs[p.slot] = d.keygroups(p);
    return c.kgs[p.slot];
  }

  function ctx() {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }

  // Voices used to connect straight to ac.destination. One gain node in front of it
  // changes nothing about what you hear and gives the whole voice path a single point to
  // meter, silence or tap.
  var master = null;

  function out() {
    var ac = ctx();
    if (!master) { master = ac.createGain(); master.connect(ac.destination); }
    return master;
  }

  // -------------------------------------------------------------------- undo

  /*
   * A step is a whole disk image. At 800 KB each, 24 of them is about 19 MB -
   * cheap enough not to think about, and it makes undo exact whatever the edit
   * touched: bytes, allocation, directory and all.
   */
  var UNDO_DEPTH = 24;
  var undoStack = [], redoStack = [];

  /**
   * Records a disk's state before an edit. `gesture` collapses repeats of the
   * same thing - dragging an envelope corner, nudging the slider - into one step.
   */
  function pushUndo(d, what, gesture) {
    if (!d) return;

    var top = undoStack[undoStack.length - 1];
    if (gesture && top && top.disk === d && top.what === what) return;

    undoStack.push({ disk: d, image: d.image.slice(), modified: d.modified, what: what });
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }

  function updateUndoButtons() {
    var u = undoStack[undoStack.length - 1], r = redoStack[redoStack.length - 1];
    $('undo').disabled = !u;
    $('redo').disabled = !r;
    $('undo').title = u ? 'Undo ' + u.what : 'Nothing to undo';
    $('redo').title = r ? 'Redo ' + r.what : 'Nothing to redo';
  }

  function step(from, to, verb) {
    if (!from.length) return;

    var s = from.pop();
    to.push({ disk: s.disk, image: s.disk.image.slice(), modified: s.disk.modified, what: s.what });

    s.disk.image.set(s.image);
    s.disk.modified = s.modified;
    s.disk.parseDirectory();

    stop();
    reshow(s.disk);
    updateUndoButtons();
    say(verb + ' ' + s.what + '.');
  }

  /** Redisplays whatever was selected, or the disk if that file has gone. */
  function reshow(d) {
    buildTree();
    var slot = sel && sel.entry ? sel.entry.slot : -1;

    for (var i = 0; i < d.entries.length; i++)
      if (d.entries[i].slot === slot) {
        showFile(d, d.entries[i],
                 document.querySelector('[data-key="' + d.name + '/' + slot + '"]'));
        return;
      }
    showDisk(d);
  }

  /**
   * The current entry in a slot. Every edit reparses the directory into fresh objects,
   * so an entry captured earlier still carries the old header. Resolve by slot instead
   * of holding the object, or the panel redraws from a ghost.
   */
  function entryAt(d, slot) {
    for (var i = 0; i < d.entries.length; i++)
      if (d.entries[i].slot === slot) return d.entries[i];
    return null;
  }

  function say(msg) { $('status').textContent = msg; }
  function fmt(n) { return (n | 0).toLocaleString(); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ------------------------------------------------------------------ loading

  function openFiles(list) {
    var files = Array.prototype.slice.call(list);
    if (!files.length) return;

    var done = 0, failed = [];
    say('Reading ' + files.length + ' file(s)...');

    files.forEach(function (f) {
      var r = new FileReader();
      r.onload = function () {
        try {
          var disk = Akai.load(f.name, new Uint8Array(r.result));
          disks = disks.filter(function (d) { return d.name !== disk.name; });
          disks.push(disk);
        } catch (e) {
          failed.push(f.name + ': ' + e.message);
        }
        if (++done === files.length) finish(failed);
      };
      r.onerror = function () {
        failed.push(f.name + ': could not be read');
        if (++done === files.length) finish(failed);
      };
      r.readAsArrayBuffer(f);
    });
  }

  function finish(failed) {
    disks.sort(function (a, b) { return a.name.localeCompare(b.name); });
    buildTree();

    if (disks.length && !sel) sel = { disk: disks[0], entry: null };
    $('save').disabled = !disks.length;
    $('newProgram').disabled = !disks.length;
    $('addSampleBtn').style.display = disks.length ? '' : 'none';

    var bad = disks.reduce(function (s, d) { return s + d.badCrc; }, 0);
    var miss = disks.reduce(function (s, d) { return s + d.missing; }, 0);
    var files = disks.reduce(function (s, d) { return s + d.entries.length; }, 0);

    say(disks.length + ' disk(s), ' + files + ' file(s)' +
        (bad === 0 && miss === 0 ? '  -  all sectors read cleanly'
                                 : '  -  ' + bad + ' bad-CRC, ' + miss + ' unreadable') +
        (failed.length ? '  -  ' + failed.length + ' failed' : ''));

    if (failed.length) console.warn(failed.join('\n'));
  }

  // --------------------------------------------------------------------- tree

  // Only what can be read and edited. Every disk also carries a drum set and an overall
  // settings file, but the library holds no real drum kit - the four marked in use are one
  // factory default copied about, identical on disks with 5 and with 26 samples - and
  // neither file has any decoded parameter. They stay on the disk untouched, and the disk
  // view still counts them; they just do not earn a place in the tree.
  var GROUPS = [['Programs', 'P'], ['Samples', 'S']];

  /** <details> gives working disclosure without any script of our own. */
  function node(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function buildTree() {
    var nav = $('tree');
    nav.textContent = '';

    if (!disks.length) {
      nav.appendChild(node('p', 'empty', 'No disks loaded.'));
      return;
    }

    disks.forEach(function (d) {
      var dk = document.createElement('details');
      dk.open = openState[d.name] !== false;
      dk.ontoggle = function () { openState[d.name] = dk.open; };

      // Count what the tree actually lists, not every file on the disk - the drum set
      // and overall settings are not shown, and a header that counted them would leave
      // the user two items short with no explanation. The disk view names them instead.
      var listed = d.entries.filter(function (e) {
        return GROUPS.some(function (g) { return g[1] === e.type; });
      }).length;

      var head = node('summary', 'disk' + (d.modified ? ' dirty' : ''),
                      (d.modified ? '* ' : '') + d.name + '  (' + listed + ')');
      head.onclick = function () { setTimeout(function () { showDisk(d); }, 0); };
      dk.appendChild(head);

      GROUPS.forEach(function (g) {
        var items = d.entries.filter(function (e) { return e.type === g[1]; });
        if (!items.length) return;

        var key = d.name + '/' + g[0];
        var grp = document.createElement('details');
        grp.open = openState[key] !== false;
        grp.ontoggle = function () { openState[key] = grp.open; };
        grp.appendChild(node('summary', 'group', g[0] + '  (' + items.length + ')'));

        items.forEach(function (e) {
          var slot = e.slot;
          var li = node('div', 'item', e.name);
          li.dataset.key = d.name + '/' + slot;
          li.onclick = function () {
            var now = entryAt(d, slot);
            if (now) showFile(d, now, li);
          };
          grp.appendChild(li);
        });
        dk.appendChild(grp);
      });

      nav.appendChild(dk);
    });

    if (sel && sel.entry) markSelected(
      nav.querySelector('[data-key="' + sel.disk.name + '/' + sel.entry.slot + '"]'));
  }

  function markSelected(el) {
    Array.prototype.forEach.call(document.querySelectorAll('nav .item.sel'),
      function (n) { n.classList.remove('sel'); });
    if (el) el.classList.add('sel');
  }

  // ------------------------------------------------------------------ detail

  function raw16(d, e, off) { var b = d.readFile(e); return b[off] | (b[off + 1] << 8); }

  function row(table, k, v) {
    var tr = table.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = v;
  }

  function hideAll() {
    ['progWrap', 'smpWrap', 'kgWrap', 'kgEdit', 'waveWrap']
      .forEach(function (id) { $(id).hidden = true; });
    $('fileOps').hidden = true;
    $('fileFacts').textContent = '';
  }

  /** The read-only half of the info strip, to the right of the editable fields. */
  function facts(parts) {
    $('fileFacts').textContent = parts.filter(Boolean).join('   \u00B7   ');
  }

  /**
   * The program header, as decoded in format section 7.1. Renaming lives on the
   * file heading rather than here, since it applies to samples just as much.
   */
  function showProgram(d, e) {
    var raw = d.readFile(e);
    var box = $('progParams');
    box.textContent = '';

    function field(label, get, set, lo, hi) {
      var wrap = node('label', null, label);
      var input = document.createElement('input');
      input.type = 'number';
      input.min = lo;
      input.max = hi;
      input.value = get();
      input.onchange = function () {
        var v = clamp(parseInt(input.value, 10) || 0, lo, hi);
        input.value = v;
        pushUndo(d, e.name + ' ' + label);
        set(v);
        touched(e.name + ' ' + label);
        showFile(d, sel.entry, document.querySelector('[data-key="' + d.name + '/' + e.slot + '"]'));
      };
      wrap.appendChild(input);
      box.appendChild(wrap);
    }

    // MIDI program change, shown from 1 as the panel does
    field('MIDI prog', function () { return raw[26] + 1; },
          function (v) { d.pokeFile(e, 26, v - 1); }, 1, 128);

    // signed 16-bit at 0x10
    field('Key to loudness',
          function () { return ((raw[16] | (raw[17] << 8)) << 16) >> 16; },
          function (v) { d.pokeFile(e, 16, v & 0xFF); d.pokeFile(e, 17, (v >> 8) & 0xFF); },
          -50, 50);

    var lab = node('label', null, '');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = raw[21] !== 0;
    cb.onchange = function () {
      pushUndo(d, e.name + ' positional crossfade');
      d.pokeFile(e, 21, cb.checked ? 255 : 0);
      touched(e.name + ' positional crossfade');
    };
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode('Crossfade'));
    box.appendChild(lab);

    $('progWrap').hidden = false;
  }

  /**
   * A sample's own header, inline in the strip. Offsets are as listed in format
   * section 6.1: the tuning word at 0x16 carries the nominal pitch in its whole
   * semitones and the fine pitch in the remainder.
   */
  function showSample(d, e) {
    var box = $('smpParams');
    box.textContent = '';

    // The entry carries a parsed copy of the header, so it has to be reparsed before
    // anything reads it back - including the write callbacks below, which derive the
    // tuning word from the other half of the pair.
    function cur() { return entryAt(d, e.slot) || e; }

    function refresh() {
      d.parseDirectory();
      showFile(d, cur(), document.querySelector('[data-key="' + d.name + '/' + e.slot + '"]'));
    }

    function number(label, value, lo, hi, write) {
      var wrap = node('label', null, label);
      var input = document.createElement('input');
      input.type = 'number';
      input.min = lo;
      input.max = hi;
      input.value = value;
      input.onchange = function () {
        var v = clamp(parseInt(input.value, 10) || 0, lo, hi);
        input.value = v;
        pushUndo(d, e.name + ' ' + label);
        write(v);
        touched(e.name + ' ' + label);
        refresh();
      };
      wrap.appendChild(input);
      box.appendChild(wrap);
    }

    function choice(label, options, value, write) {
      var wrap = node('label', null, label);
      var pick = document.createElement('select');
      options.forEach(function (o) { pick.appendChild(new Option(o[1], o[0])); });
      pick.value = value;
      pick.onchange = function () {
        pushUndo(d, e.name + ' ' + label);
        write(pick.value);
        touched(e.name + ' ' + label);
        refresh();
      };
      wrap.appendChild(pick);
      box.appendChild(wrap);
    }

    function setTuning(t) {
      d.pokeFile(cur(), 0x16, t & 0xFF);
      d.pokeFile(cur(), 0x17, (t >> 8) & 0xFF);
    }

    number('Pitch', e.nominalPitch, 0, 127, function (v) {
      setTuning(v * 16 + cur().finePitch);
    });

    number('Fine', e.finePitch, 0, 15, function (v) {
      setTuning(cur().nominalPitch * 16 + v);
    });

    number('Loudness', e.loudness, -50, 50, function (v) {
      d.pokeFile(cur(), 0x18, v & 0xFF);
      d.pokeFile(cur(), 0x19, (v >> 8) & 0xFF);
    });

    // Not a poke: a sample's loop mode decides how many descriptors it takes, so
    // changing it moves the descriptor pointer of every sample after it.
    choice('Loop', [['O', 'one-shot'], ['L', 'looping'], ['A', 'alternating']], e.loopMode,
           function (v) { d.setLoopMode(cur(), v); });

    /*
     * Also not a poke, and this one used to be.
     *
     * Time direction is a DESTRUCTIVE edit on the machine - measured: a sample written
     * forwards with 0x2B set to 'R' plays forwards, one-shot or looping. So the panel must
     * rewrite the audio backwards and keep the byte as a record, and poking the byte on its
     * own marked a sample as reversed while it went on playing forwards. A disk that
     * contradicts itself, from a one-line control that looked harmless.
     *
     * setSampleDirection reverses the audio, moves the loop to cover the same sound, and
     * writes the byte - and does nothing at all if the direction is already what was asked
     * for, so opening the panel and closing it cannot reverse anything by accident.
     */
    choice('Dir', [['N', 'normal'], ['R', 'reverse (rewrites the audio)']], e.loopDirection,
           function (v) { d.setSampleDirection(cur(), v); });

    $('smpWrap').hidden = false;
  }

  function showDisk(d) {
    sel = { disk: d, entry: null };
    markSelected(null);
    $('intro').hidden = true;
    $('file').hidden = false;
    hideAll();
    $('infoBar').hidden = false;
    $('save').disabled = false;
    $('newProgram').disabled = false;
    facts([fmt(d.freeBlocks()) + ' blocks free',
           d.entries.length + ' files',
           d.isHfe ? 'HFE' : 'raw image']);

    $('fileName').textContent = d.name;
    var t = $('fields');
    t.textContent = '';
    row(t, 'Image', d.isHfe ? 'HFE (HXCPICFE)' : 'raw sector image');
    row(t, 'Blocks', fmt(d.totalBlocks()) + ' x ' + Akai.BLOCK + ' bytes');
    row(t, 'Blocks free', fmt(d.freeBlocks()));
    row(t, 'Files', fmt(d.entries.length));

    // Say what the tree leaves out, so the file count adds up.
    var hidden = d.entries.filter(function (x) { return x.type === 'D' || x.type === 'O'; });
    if (hidden.length)
      row(t, 'Not listed', hidden.map(function (x) { return x.name.trim(); }).join(', ') +
          '  -  kept on the disk, nothing in them is decoded');
    row(t, 'Bad-CRC sectors', fmt(d.badCrc));
    row(t, 'Unreadable sectors', fmt(d.missing));
  }

  function showFile(d, e, el) {
    e = entryAt(d, e.slot) || e;       // never redraw from a stale copy
    sel = { disk: d, entry: e };
    selKeygroup = -1;
    selSet = [];
    selAnchor = -1;
    markSelected(el);
    stop();

    $('intro').hidden = true;
    $('file').hidden = false;
    $('save').disabled = false;
    $('newProgram').disabled = false;
    $('fileName').textContent = e.name;

    var t = $('fields');
    t.textContent = '';
    row(t, 'Type', e.typeName);
    row(t, 'Directory slot', e.slot);
    row(t, 'Length', fmt(e.length) + ' bytes');
    row(t, 'Start block', e.startBlock);
    row(t, 'Blocks allocated', e.chainBlocks);
    if (!e.chainOk) row(t, 'Warning', 'allocation smaller than the declared length');

    hideAll();
    $('infoBar').hidden = false;
    $('fileOps').hidden = !(e.type === 'P' || e.type === 'S');
    $('opDelete').hidden = !(e.type === 'S' || e.type === 'P');
    fillCopyTo(d, e);

    if (e.type === 'S') {
      t.textContent = '';
      facts([fmt(e.sampleCount) + ' words',
             fmt(e.sampleRate) + ' Hz',
             e.seconds.toFixed(2) + ' s',
             fmt(e.length) + ' bytes']);
      showSample(d, e);
      showWave(d, e);
    } else if (e.type === 'P') {
      // A program says everything it needs to on one line, so the table stays empty.
      t.textContent = '';
      facts([d.keygroupCount(e) + ' keygroups',
             fmt(e.length) + ' bytes',
             e.chainBlocks + ' block' + (e.chainBlocks === 1 ? '' : 's'),
             'load 0x' + raw16(d, e, 18).toString(16).toUpperCase(),
             d.readFile(e)[22] === 0 ? 'S950' : 'S900']);
      showProgram(d, e);
      showKeygroups(d, e);
    } else {
      t.textContent = '';
      facts([fmt(e.length) + ' bytes',
             e.chainBlocks + ' block' + (e.chainBlocks === 1 ? '' : 's'),
             'slot ' + e.slot]);
    }
  }

  // --------------------------------------------------------------- keygroups

  /**
   * Just the numbers. Every other column this list used to carry - key range,
   * envelopes, filter, zone samples - is an editable field in the panel beside it,
   * so the list stays narrow and the editor gets the width. What the panel cannot
   * show at a glance is which keygroups point at a sample that is not on this disk:
   * those stay marked, and the row's tooltip carries the detail.
   */
  function showKeygroups(d, e) {
    var kgs = d.keygroups(e);
    var here = {};
    d.entries.forEach(function (x) { if (x.type === 'S') here[x.name] = true; });

    var t = $('keygroups');
    t.textContent = '';

    var body = t.createTBody();
    kgs.forEach(function (kg, i) {
      var onDisk = !!here[kg.zone1.name];
      var tr = body.insertRow();
      if (!onDisk) tr.classList.add('away');
      tr.insertCell().textContent = i + 1;
      tr.title = 'Keys ' + kg.lowKey + ' - ' + kg.highKey +
                 (kg.zone1.name.trim() ? '   ' + kg.zone1.name.trim() : '') +
                 (kg.zone2.inUse ? ' / ' + kg.zone2.name.trim() : '') +
                 (onDisk ? '' : '   (sample not on this disk)');
      tr.onclick = function (ev) { clickKeygroup(i, ev); };
    });

    spans = kgs.map(function (kg, i) {
      return { index: i, low: Math.min(kg.lowKey, kg.highKey),
               high: Math.max(kg.lowKey, kg.highKey), sample: kg.zone1.name };
    });

    $('kgCount').textContent = '- ' + kgs.length;
    $('kgAdd').disabled = kgs.length >= Akai.MAX_KEYGROUPS;
    $('kgDel').disabled = true;
    $('kgCopy').disabled = true;

    // a program the selection outlived - a delete, or an undo of an add
    selSet = selSet.filter(function (i) { return i < kgs.length; });
    $('kgWrap').hidden = false;
    $('kgEdit').hidden = true;
    $('waveWrap').hidden = true;
    drawPiano();

    if (kgs.length) pickKeygroup(Math.min(Math.max(selKeygroup, 0), kgs.length - 1));
  }

  /**
   * A click in the list. Plain replaces the selection, ctrl - or cmd - adds and removes
   * one, shift takes the run from the anchor: the bargain every file list makes, and the
   * one people try first.
   */
  function clickKeygroup(i, ev) {
    if (!sel || !sel.entry) return;
    var n = sel.disk.keygroupCount(sel.entry);
    if (i < 0 || i >= n) return;

    if (ev && ev.shiftKey && selAnchor >= 0 && selAnchor < n) {
      var lo = Math.min(selAnchor, i), hi = Math.max(selAnchor, i);
      selSet = [];
      for (var k = lo; k <= hi; k++) selSet.push(k);
    } else if (ev && (ev.ctrlKey || ev.metaKey)) {
      var at = selSet.indexOf(i);
      // the last one cannot be taken out: something has to be in the editor
      if (at >= 0 && selSet.length > 1) selSet.splice(at, 1);
      else if (at < 0) selSet.push(i);
      selAnchor = i;
    } else {
      selSet = [i];
      selAnchor = i;
    }
    selSet.sort(function (a, b) { return a - b; });
    pickKeygroup(selSet.indexOf(i) >= 0 ? i : selSet[0]);
  }

  function pickKeygroup(i) {
    disarmRange(true);            // the keyboard was armed for the keygroup you left
    var d = sel.disk, e = sel.entry;
    var kgs = d.keygroups(e);
    if (i < 0 || i >= kgs.length) return;

    selKeygroup = i;
    // arriving anywhere outside the selection - the keyboard, a rebuilt list - starts
    // a fresh one; clicking inside it leaves the rest of the selection alone
    if (selSet.indexOf(i) < 0) { selSet = [i]; selAnchor = i; }

    var rows = $('keygroups').tBodies[0].rows;
    for (var r = 0; r < rows.length; r++) {
      rows[r].classList.toggle('sel', selSet.indexOf(r) >= 0);
      rows[r].classList.toggle('lead', r === selKeygroup);
    }

    $('kgDel').disabled = kgs.length <= selSet.length;

    // One at a time: copying a run of keygroups is a different question, and answering it
    // badly here would be worse than not answering it.
    $('kgCopy').disabled = selKeygroup < 0;
    drawPiano();
    showKeygroupEditor(kgs[i], i);

    var kg = kgs[i];
    var s = findSample(d, kg.zone1.name) || (kg.zone2.inUse ? findSample(d, kg.zone2.name) : null);
    if (s) showWave(d, s); else $('waveWrap').hidden = true;
  }

  /**
   * Selecting several keygroups and moving one control is how you set the same filter,
   * or the same envelope, across a whole drum kit. Every edit in the editor goes
   * through these three, so nothing can quietly apply to the lead alone.
   */
  function editTargets() {
    if (!sel || !sel.entry || selKeygroup < 0) return [];
    return selSet.indexOf(selKeygroup) < 0 ? [selKeygroup] : selSet.slice();
  }

  /** What an edit is called, in the undo list and in the status line. */
  function editLabel(what) {
    var n = editTargets().length;
    return what + (n > 1 ? ' on ' + n + ' keygroups' : ' on keygroup ' + (selKeygroup + 1));
  }

  /** The same byte into every selected keygroup. */
  function writeAll(offset, value) {
    editTargets().forEach(function (i) {
      sel.disk.setKeygroupByte(sel.entry, i, offset, value & 0xFF);
    });
  }

  function findSample(d, name) {
    if (!name) return null;
    var want = name.trim().toUpperCase();
    for (var i = 0; i < d.entries.length; i++) {
      var e = d.entries[i];
      if (e.type === 'S' && e.name.trim().toUpperCase() === want) return e;
    }
    return null;
  }

  function refreshKeygroups() {
    sel.disk.parseDirectory();
    for (var i = 0; i < sel.disk.entries.length; i++)
      if (sel.disk.entries[i].slot === sel.entry.slot) sel.entry = sel.disk.entries[i];

    buildTree();
    showKeygroups(sel.disk, sel.entry);
  }

  // ----------------------------------------------------- keygroup parameters

  function showKeygroupEditor(kg, index) {
    var many = editTargets().length;
    $('kgEditNum').textContent = '- ' + (index + 1) + ' of ' +
      sel.disk.keygroupCount(sel.entry) +
      (many > 1 ? '   \u00B7   editing ' + many + ' selected' : '');
    $('kgEdit').hidden = false;

    // Three grids: the keys and the velocity under the envelopes, the LFO beside them,
    // and the zones and flags in the column to the right.
    var box = $('paramsTop');
    box.textContent = '';
    $('paramsLfo').textContent = '';
    $('params').textContent = '';

    /**
     * One parameter: a slider with its value beside it. These are things you sweep by
     * ear rather than numbers you arrive knowing, so it writes as it moves - the whole
     * drag is a single undo, and the editor is only rebuilt when the handle is let go,
     * since rebuilding it mid-drag would pull the slider out from under the pointer.
     * The same bargain the VCF amount slider has always made.
     */
    function field(offset, label, lo, hi, signed) {
      box.appendChild(node('label', null, label));

      var cell = node('div', 'slider');
      var input = document.createElement('input');
      input.type = 'range';
      input.min = lo;
      input.max = hi;
      input.step = 1;
      input.title = label;
      input.setAttribute('aria-label', label);
      var raw = kg.raw[offset];
      var val = signed ? ((raw << 24) >> 24) : raw;
      // A disk is free to hold something outside the range the panel offers. Clamping
      // the slider would report a value the disk does not have, so it stretches to fit
      // what is there and only the next drag brings it back into range.
      if (val > hi) input.max = val;
      if (val < lo) input.min = val;
      input.value = val;

      var read = node('span', 'val', val);

      input.oninput = function () {
        var v = clamp(parseInt(input.value, 10) || 0, lo, hi);
        read.textContent = v;
        pushUndo(sel.disk, editLabel(label), true);
        writeAll(offset, v);
        touched(editLabel(label));
      };
      input.onchange = function () { refreshKeygroups(); };

      cell.appendChild(input);
      cell.appendChild(read);
      box.appendChild(cell);
      return input;
    }

    function heading(text) {
      var d = node('div', 'head', text);
      box.appendChild(d);
      return d;
    }

    // Two boxes wanting MIDI numbers were a poor way to say something the keyboard
    // says better, so the section is the button alone - and the keyboard caption above
    // carries the range the selected keygroup currently has.
    heading('Key range').appendChild(rangeButton(index));

    heading('Velocity');
    // The byte is a split point, so only 1-127 says anything; 128 turns the switch off,
    // and that is what 1,860 of the 1,908 keygroups on the original 101 disks hold. The
    // library never goes above it, and neither did the panel.
    field(2, 'Velocity switch', 1, 128).title =
      'The hardest velocity zone 1 answers. Zone 2 takes everything above it, so 128 turns ' +
      'the switch off and zone 1 takes every velocity there is.';
    field(11, 'To loudness', 0, 99);
    field(7, 'To filter', 0, 99);
    field(9, 'To attack', 0, 99);
    field(10, 'To release', -50, 50, true);
    field(8, 'Key to filter', 0, 99);

    box = $('paramsLfo');       // beside the keys and the velocity, still under the envelopes

    heading('LFO');
    field(15, 'Delay', 0, 99);
    field(16, 'Rate', 0, 99);
    field(17, 'Depth', 0, 99);
    field(21, 'From aftertouch', 0, 99);
    field(22, 'From modwheel', 0, 99);

    box = $('params');          // the third column, beside the whole of the rest

    zone(0, 'Zone 1', kg.zone1);
    zone(1, 'Zone 2', kg.zone2);

    function zone(which, title, z) {
      var t = kg.raw[2];
      heading(t >= 128
        ? (which === 0 ? 'Zone 1  -  sample' : 'Zone 2  -  unused (velocity switch off)')
        // The byte is the LAST velocity of zone 1, measured on the hardware - see
        // Akai.zoneForVelocity. This used to read 1-(t-1) and t-127, a step out either side.
        : (which === 0 ? title + '  -  soft (velocity 1-' + t + ')'
                       : title + '  -  hard (velocity ' + (t + 1) + '-127)'));

      box.appendChild(node('label', null, 'Sample'));
      var pick = document.createElement('select');
      pick.appendChild(new Option('(none)', ''));

      sel.disk.entries.forEach(function (e) {
        if (e.type !== 'S') return;
        pick.appendChild(new Option(e.name, e.name));
      });
      // a zone can name a sample that lives on another disk
      if (z.inUse && !findSample(sel.disk, z.name))
        pick.appendChild(new Option(z.name + '  (elsewhere)', z.name));

      pick.value = z.inUse ? z.name : '';
      pick.onchange = function () {
        pushUndo(sel.disk, editLabel(title + ' sample'));
        editTargets().forEach(function (i) {
          if (pick.value) sel.disk.setZoneSample(sel.entry, i, which, pick.value);
          else sel.disk.clearZone(sel.entry, i, which);
        });
        touched(editLabel(title + ' sample'));
        refreshKeygroups();
      };
      box.appendChild(pick);

      var base = 24 + which * 22;
      field(base + 20, 'Filter', 0, 99);
      field(base + 21, 'Loudness', -50, 50, true);
      field(base + 19, 'Transpose', -50, 50, true);
      field(base + 18, 'Fine', 0, 255);
    }

    heading('Flags');
    flag(0x01, 'Constant pitch');
    flag(0x04, 'LFO desync');
    flag(0x08, 'One shot');

    function flag(bit, label) {
      box.appendChild(node('label', null, label));
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = (kg.raw[18] & bit) !== 0;
      cb.onchange = function () {
        pushUndo(sel.disk, editLabel(label));
        // the one bit, not the whole byte: the others belong to each keygroup
        var now = sel.disk.keygroups(sel.entry);
        editTargets().forEach(function (i) {
          var cur = now[i].raw[18];
          sel.disk.setKeygroupByte(sel.entry, i, 18, (cur & ~bit) | (cb.checked ? bit : 0));
        });
        touched(editLabel(label));
        refreshKeygroups();
      };
      box.appendChild(cb);
    }

    /** The 'from the keyboard' button, labelled with whichever click it wants next. */
    function rangeButton(index) {
      var b = document.createElement('button');
      b.type = 'button';
      b.id = 'kgSetRange';
      b.title = 'Set the range by clicking the keyboard above: the low key, then the high.' +
                '\nThe same key twice gives a one-key group. Esc cancels.';
      b.onclick = function () { if (setRange.on) disarmRange(); else armRange(index); };
      b.textContent = 'From keyboard';
      return b;
    }

    env.vca.set(kg.vca);

    // An S900-era keygroup leaves the filter envelope as ASCII spaces, which would show
    // as 32/32/32/32 - a plausible-looking envelope that was never set. Show a neutral
    // one instead; dragging it writes real values and the program becomes S950-era.
    env.vcf.set(kg.vcfWritten ? kg.vcf : [0, 0, 99, 0]);
    $('vcfAmt').value = kg.vcfAmount;
    $('vcfAmtLabel').innerHTML = 'amt<br>' + (kg.vcfAmount > 0 ? '+' : '') + kg.vcfAmount;
    drawEnv('vca');
    drawEnv('vcf');
  }

  function touched(what) {
    sel.disk.modified = true;
    say('Edited ' + what + '.  Unsaved changes - use Download image.');
  }

  // ------------------------------------------------------------- envelopes

  var env = {
    vca: { v: [0, 0, 0, 0], bytes: [3, 4, 5, 6], title: 'VCA', drag: -1 },
    vcf: { v: [0, 0, 0, 0], bytes: [34, 35, 36, 37], title: 'VCF', drag: -1 }
  };
  env.vca.set = function (a) { this.v = a.slice(); };
  env.vcf.set = function (a) { this.v = a.slice(); };

  var PAD = 10, KNOB = 9, LABEL = 15;

  function envGeom(c) {
    var W = c.clientWidth, H = c.clientHeight;
    var top = PAD + LABEL, bottom = Math.max(top + 10, H - PAD);
    var span = Math.max(30, W - 2 * PAD);
    var hold = span * 0.18, unit = (span - hold) / 3;
    return { W: W, H: H, left: PAD, top: top, bottom: bottom, unit: unit, hold: hold };
  }

  function envPoints(g, v) {
    var sy = g.bottom - v[2] / 99 * (g.bottom - g.top);
    var p1x = g.left + v[0] / 99 * g.unit;
    var p2x = p1x + v[1] / 99 * g.unit;
    var p3x = p2x + g.hold;
    return {
      p0: [g.left, g.bottom], p1: [p1x, g.top], p2: [p2x, sy],
      p3: [p3x, sy], p4: [p3x + v[3] / 99 * g.unit, g.bottom]
    };
  }

  function drawEnv(which) {
    var c = $(which);
    if (!ready(c, function () { drawEnv(which); })) return;

    var s = sizeCanvas(c), ctx2 = s.g;
    var e = env[which];
    var g = envGeom(c), pt = envPoints(g, e.v);

    ctx2.clearRect(0, 0, s.w, s.h);
    ctx2.fillStyle = '#fafafc';
    ctx2.fillRect(0, 0, s.w, s.h);

    ctx2.strokeStyle = '#cdd0d6';
    ctx2.strokeRect(g.left + 0.5, g.top + 0.5, s.w - 2 * PAD - 1, g.bottom - g.top);
    ctx2.beginPath();
    ctx2.moveTo(g.left, (g.top + g.bottom) / 2);
    ctx2.lineTo(s.w - PAD, (g.top + g.bottom) / 2);
    ctx2.stroke();

    ctx2.beginPath();
    ctx2.moveTo(pt.p0[0], pt.p0[1]);
    [pt.p1, pt.p2, pt.p3, pt.p4].forEach(function (p) { ctx2.lineTo(p[0], p[1]); });
    ctx2.lineTo(pt.p4[0], g.bottom);
    ctx2.closePath();
    ctx2.fillStyle = 'rgba(92,152,224,0.28)';
    ctx2.fill();

    ctx2.beginPath();
    ctx2.moveTo(pt.p0[0], pt.p0[1]);
    [pt.p1, pt.p2, pt.p3, pt.p4].forEach(function (p) { ctx2.lineTo(p[0], p[1]); });
    ctx2.strokeStyle = '#3e76b8';
    ctx2.lineWidth = 1.8;
    ctx2.stroke();
    ctx2.lineWidth = 1;

    [pt.p1, pt.p2, pt.p4].forEach(function (p, i) {
      ctx2.fillStyle = e.drag === i ? '#e88c28' : '#1c4e8c';
      ctx2.fillRect(p[0] - KNOB / 2, p[1] - KNOB / 2, KNOB, KNOB);
      ctx2.strokeStyle = '#fff';
      ctx2.strokeRect(p[0] - KNOB / 2, p[1] - KNOB / 2, KNOB, KNOB);
    });

    ctx2.fillStyle = '#5c6370';
    ctx2.font = 'bold 11px "Segoe UI", sans-serif';
    ctx2.fillText(e.title + '    A ' + e.v[0] + '   D ' + e.v[1] +
                  '   S ' + e.v[2] + '   R ' + e.v[3], PAD - 2, 12);
  }

  function envHit(c, which, ev) {
    var box = c.getBoundingClientRect();
    var x = ev.clientX - box.left, y = ev.clientY - box.top;
    var g = envGeom(c), pt = envPoints(g, env[which].v);
    var hs = [pt.p1, pt.p2, pt.p4];

    for (var i = 0; i < 3; i++)
      if (Math.abs(x - hs[i][0]) <= KNOB && Math.abs(y - hs[i][1]) <= KNOB) return i;
    return -1;
  }

  function wireEnv(which) {
    var c = $(which);

    c.addEventListener('mousedown', function (ev) {
      env[which].drag = envHit(c, which, ev);
      if (env[which].drag < 0) return;
      pushUndo(sel && sel.disk, editLabel(env[which].title + ' envelope'), true);
      drawEnv(which);
    });

    window.addEventListener('mousemove', function (ev) {
      var e = env[which];
      if (e.drag < 0) return;

      var box = c.getBoundingClientRect();
      var x = ev.clientX - box.left, y = ev.clientY - box.top;
      var g = envGeom(c), pt = envPoints(g, e.v);

      if (e.drag === 0) e.v[0] = clamp(Math.round((x - g.left) / g.unit * 99), 0, 99);
      else if (e.drag === 1) {
        e.v[1] = clamp(Math.round((x - pt.p1[0]) / g.unit * 99), 0, 99);
        e.v[2] = clamp(Math.round((g.bottom - y) / (g.bottom - g.top) * 99), 0, 99);
      } else e.v[3] = clamp(Math.round((x - pt.p3[0]) / g.unit * 99), 0, 99);

      drawEnv(which);
      writeEnv(which);
    });

    window.addEventListener('mouseup', function () {
      if (env[which].drag < 0) return;
      env[which].drag = -1;
      drawEnv(which);
      refreshKeygroups();
    });
  }

  function writeEnv(which) {
    if (!sel || !sel.entry || selKeygroup < 0) return;
    var e = env[which];
    editTargets().forEach(function (k) {
      for (var i = 0; i < 4; i++)
        sel.disk.setKeygroupByte(sel.entry, k, e.bytes[i], e.v[i]);
    });
    touched(editLabel(e.title + ' envelope'));
  }

  // --------------------------------------------------------------- waveform

  function showWave(d, e) {
    waveEntry = e;
    waveWords = d.sampleWords12(e);
    waveEnv = null;
    waveWidth = -1;

    $('waveTitle').textContent = 'Waveform  -  ' + e.name + '   ' +
      fmt(e.sampleCount) + ' words at ' + fmt(e.sampleRate) + ' Hz,  ' + e.seconds.toFixed(2) + ' s';
    $('useLoop').checked = e.loopMode !== 'O';
    $('waveWrap').hidden = false;

    // The operations act on a sample chosen in its own right, not one reached
    // through a keygroup, where the selection is really the program.
    $('sampleOps').hidden = !(sel && sel.entry && sel.entry.type === 'S');

    drawWave();
  }

  /**
   * Matches the backing store to the display size. The layout size comes from CSS
   * via clientWidth/clientHeight - never from the width/height attributes, which
   * are what this function writes, and which would otherwise compound.
   */
  /**
   * A canvas shown in the same task that laid it out can still report zero width,
   * which would leave it blank until something forced a redraw. Anything drawing
   * calls this first and comes back on the next frame if the size is not there yet.
   */
  function ready(c, redraw) {
    if (c.clientWidth > 0 && c.clientHeight > 0) return true;
    setTimeout(redraw, 0);   // not rAF: this must also work when frames are throttled
    return false;
  }

  function sizeCanvas(c) {
    var dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth, h = c.clientHeight;

    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g: g, w: w, h: h };
  }

  function drawWave() {
    var c = $('wave');
    if (!ready(c, drawWave)) return;

    var s = sizeCanvas(c), g = s.g, W = s.w, H = s.h;
    var ruler = 16, plot = H - ruler;

    g.clearRect(0, 0, W, H);
    g.fillStyle = '#fafafc';
    g.fillRect(0, 0, W, H);
    if (!waveWords || !waveWords.length) return;

    if (waveWidth !== W) { waveEnv = envelope(waveWords, W); waveWidth = W; }

    var e = waveEntry;
    var loops = e.loopMode === 'L' || e.loopMode === 'A';
    var loopFrom = Math.max(e.loopStart, e.loopEnd - e.loopLength);
    var xOf = function (w) { return Math.round(clamp(w / waveWords.length, 0, 1) * (W - 1)); };

    if (loops && e.loopLength > 0 && e.loopEnd > loopFrom) {
      g.fillStyle = '#e8f0fa';
      g.fillRect(xOf(loopFrom), 0, Math.max(1, xOf(e.loopEnd) - xOf(loopFrom)), plot);
    }

    g.strokeStyle = '#cdd0d6';
    g.beginPath(); g.moveTo(0, plot / 2); g.lineTo(W, plot / 2); g.stroke();

    for (var x = 0; x < W; x++) {
      var word = x * waveWords.length / W;
      g.strokeStyle = (loops && word >= loopFrom && word <= e.loopEnd) ? '#1c4e8c' : '#3e76b8';
      var y1 = plot / 2 - waveEnv[x * 2 + 1] / 2048 * (plot / 2 - 2);
      var y2 = plot / 2 - waveEnv[x * 2] / 2048 * (plot / 2 - 2);
      g.beginPath();
      g.moveTo(x + 0.5, y1);
      g.lineTo(x + 0.5, Math.max(y2, y1 + 1));
      g.stroke();
    }

    marker(g, xOf(e.loopStart), e.loopStart, waveWords.length, plot, '#208c48', 'start');
    if (loops) marker(g, xOf(loopFrom), loopFrom, waveWords.length, plot, '#208c48', 'loop');
    if (e.loopEnd < waveWords.length)
      marker(g, xOf(e.loopEnd), e.loopEnd, waveWords.length, plot, '#be4628', 'end');

    g.fillStyle = '#5c6370';
    g.strokeStyle = '#cdd0d6';
    g.font = '10px "Segoe UI", sans-serif';
    g.beginPath(); g.moveTo(0, plot); g.lineTo(W, plot); g.stroke();

    var secs = waveWords.length / e.sampleRate;
    var step = niceStep(secs, Math.max(1, W / 80));
    for (var t = 0; t <= secs + 1e-9; t += step) {
      var tx = Math.round(t / secs * (W - 1));
      g.beginPath(); g.moveTo(tx + 0.5, plot); g.lineTo(tx + 0.5, plot + 3); g.stroke();
      g.fillText(t.toFixed(step < 1 ? 2 : 0) + ' s', tx + 3, plot + 12);
    }
  }

  function marker(g, x, word, total, plot, colour, label) {
    if (word <= 0 || word >= total) return;
    g.strokeStyle = colour;
    g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, plot); g.stroke();
    g.fillStyle = colour;
    g.font = '10px "Segoe UI", sans-serif';
    g.fillText(label, x + 3, plot - 4);
  }

  function envelope(words, W) {
    var env2 = new Int16Array(W * 2);
    for (var x = 0; x < W; x++) {
      var a = Math.floor(x * words.length / W);
      var b = Math.floor((x + 1) * words.length / W);
      if (b <= a) b = a + 1;
      if (b > words.length) b = words.length;

      var lo = 32767, hi = -32768;
      for (var i = a; i < b; i++) {
        var v = words[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      env2[x * 2] = lo;
      env2[x * 2 + 1] = hi;
    }
    return env2;
  }

  function niceStep(span, wanted) {
    var raw = span / Math.max(1, wanted);
    var mag = Math.pow(10, Math.floor(Math.log(Math.max(raw, 1e-6)) / Math.LN10));
    var n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  }

  // ----------------------------------------------------------------- keyboard

  var LOW = 21, HIGH = 108;

  function isBlack(n) {
    switch (((n % 12) + 12) % 12) {
      case 1: case 3: case 6: case 8: case 10: return true;
      default: return false;
    }
  }

  function range() {
    var lo = LOW, hi = HIGH;
    spans.forEach(function (s) { lo = Math.min(lo, s.low); hi = Math.max(hi, s.high); });
    lo = clamp(lo, 0, 127); hi = clamp(hi, 0, 127);
    while (lo > 0 && isBlack(lo)) lo--;
    while (hi < 127 && isBlack(hi)) hi++;
    return [lo, hi];
  }

  function whiteIndex(lo, note) {
    var n = 0;
    for (var i = lo; i < note; i++) if (!isBlack(i)) n++;
    return n;
  }

  function whiteCount(lo, hi) {
    var n = 0;
    for (var i = lo; i <= hi; i++) if (!isBlack(i)) n++;
    return n;
  }

  function groupAt(note) {
    if (note < 0) return -1;
    if (selKeygroup >= 0 && spans[selKeygroup] &&
        note >= spans[selKeygroup].low && note <= spans[selKeygroup].high) return selKeygroup;
    for (var i = 0; i < spans.length; i++)
      if (note >= spans[i].low && note <= spans[i].high) return i;
    return -1;
  }

  function keyRects(W, H) {
    var r = range(), lo = r[0], hi = r[1];
    var ww = (W - 1) / Math.max(1, whiteCount(lo, hi));
    var top = 16, kh = H - top - 14;
    return {
      lo: lo, hi: hi, ww: ww, top: top, kh: kh,
      white: function (n) { return { x: whiteIndex(lo, n) * ww, y: top, w: ww, h: kh }; },
      black: function (n) {
        var bw = ww * 0.62;
        return { x: (whiteIndex(lo, n - 1) + 1) * ww - bw / 2, y: top, w: bw, h: kh * 0.62 };
      }
    };
  }

  function drawPiano() {
    var c = $('piano');
    if (!ready(c, drawPiano)) return;

    var s = sizeCanvas(c), g = s.g, W = s.w, H = s.h;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#f4f5f8';
    g.fillRect(0, 0, W, H);

    var k = keyRects(W, H);
    // while the range is being set, what the two clicks will give takes precedence
    // over the keygroup colours - it is the only thing being decided
    var pend = pendingRange();
    var fill = function (note, black) {
      if (setRange.on && (note === setRange.low || (pend && note >= pend.lo && note <= pend.hi)))
        return black ? '#a83800' : '#f3cdb2';
      var grp = groupAt(note);
      if (grp < 0) return black ? '#262626' : '#ffffff';
      if (grp === selKeygroup) return black ? '#1a5294' : '#5c98e0';
      // the rest of a multiple selection: plainly picked, plainly not the lead
      if (selSet.length > 1 && selSet.indexOf(grp) >= 0) return black ? '#2f6ba8' : '#a9cbee';
      return black ? '#4a5c70' : '#dbe6f3';
    };

    g.strokeStyle = '#787878';
    var n, r;
    for (n = k.lo; n <= k.hi; n++) {
      if (isBlack(n)) continue;
      r = k.white(n);
      g.fillStyle = fill(n, false);
      g.fillRect(r.x, r.y, r.w, r.h);
      g.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    }
    for (n = k.lo; n <= k.hi; n++) {
      if (!isBlack(n)) continue;
      r = k.black(n);
      g.fillStyle = fill(n, true);
      g.fillRect(r.x, r.y, r.w, r.h);
      g.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    }

    g.fillStyle = '#5c6370';
    g.font = '10px "Segoe UI", sans-serif';
    if (k.ww >= 6)
      for (n = k.lo; n <= k.hi; n++)
        if (n % 12 === 0) g.fillText(Akai.noteName(n), k.white(n).x + 1, k.top + k.kh + 11);

    g.font = 'bold 11px "Segoe UI", sans-serif';
    if (setRange.on) {
      g.fillStyle = '#a83800';
      g.fillText(setRange.low < 0
        ? 'Keygroup ' + (setRange.kg + 1) + '  -  click the low key'
        : 'Keygroup ' + (setRange.kg + 1) + '  -  low ' + Akai.noteName(setRange.low) +
          ', now click the high key' +
          (pend ? '    (' + Akai.noteName(pend.lo) + ' - ' + Akai.noteName(pend.hi) + ',  ' +
                  (pend.hi - pend.lo + 1) + ' key' + (pend.hi === pend.lo ? '' : 's') + ')' : ''),
        3, 12);
    } else if (selKeygroup >= 0 && spans[selKeygroup]) {
      var sp = spans[selKeygroup];
      g.fillStyle = '#1c4e8c';
      g.fillText('Keygroup ' + (sp.index + 1) + '    ' + sp.low + ' - ' + sp.high + '    (' +
                 Akai.noteName(sp.low) + ' - ' + Akai.noteName(sp.high) + ')    ' + sp.sample +
                 (selSet.length > 1 ? '    -  ' + selSet.length + ' selected, edits reach them all'
                                    : ''), 3, 12);
    } else if (spans.length) {
      g.fillStyle = '#5c6370';
      g.fillText(spans.length + ' keygroups  -  click a key to hear it', 3, 12);
    }

    if (hoverNote >= 0) {
      var label = Akai.noteName(hoverNote) + '   ' + hoverNote;
      var tw = g.measureText(label).width + 10;
      var hx = clamp(noteCentre(k, hoverNote) - tw / 2, 0, W - tw);
      g.fillStyle = 'rgba(40,44,52,0.92)';
      g.fillRect(hx, k.top + 2, tw, 16);
      g.fillStyle = '#fff';
      g.fillText(label, hx + 5, k.top + 14);
    }
  }

  function noteCentre(k, note) {
    var r = isBlack(note) ? k.black(note) : k.white(note);
    return r.x + r.w / 2;
  }

  function armRange(index) {
    setRange.on = true;
    setRange.kg = index;
    setRange.low = -1;
    updateRangeButton();
    drawPiano();
    say('Click the low key on the keyboard, then the high key.  Esc cancels.');
  }

  function disarmRange(quiet) {
    if (!setRange.on) return;
    setRange.on = false;
    setRange.low = -1;
    updateRangeButton();
    drawPiano();
    if (!quiet) say('Key range left as it was.');
  }

  function updateRangeButton() {
    var b = $('kgSetRange');
    if (!b) return;
    b.classList.toggle('armed', setRange.on);
    b.textContent = !setRange.on ? 'From keyboard'
                  : setRange.low < 0 ? 'Click the low key' : 'Now the high key';
  }

  /** What the keyboard is showing while the second click is still to come. */
  function pendingRange() {
    if (!setRange.on || setRange.low < 0) return null;
    var h = hoverNote >= 0 ? hoverNote : setRange.low;
    return { lo: Math.min(setRange.low, h), hi: Math.max(setRange.low, h) };
  }

  /**
   * One click of the armed keyboard. Low first, then high - but clicked the other way
   * round it still reads as a range, so the pair is sorted rather than refused. Both
   * bytes go in under a single undo: the range is one edit to anyone using it.
   */
  function takeRangeClick(note) {
    if (note < 0) return;
    var index = setRange.kg;
    if (!sel || !sel.entry || sel.entry.type !== 'P' ||
        index < 0 || index >= sel.disk.keygroupCount(sel.entry)) { disarmRange(true); return; }

    if (setRange.low < 0) {
      setRange.low = note;
      updateRangeButton();
      drawPiano();
      say('Low key ' + Akai.noteName(note) + '.  Now the high key - the same key again' +
          ' for a one-key group.');
      return;
    }

    var lo = Math.min(setRange.low, note), hi = Math.max(setRange.low, note);
    disarmRange(true);
    var many = editTargets();
    pushUndo(sel.disk, editLabel('key range'));
    many.forEach(function (i) {
      sel.disk.setKeygroupByte(sel.entry, i, 1, lo);
      sel.disk.setKeygroupByte(sel.entry, i, 0, hi);
    });
    touched(editLabel('key range'));
    selKeygroup = index;
    refreshKeygroups();
    say((many.length > 1 ? many.length + ' keygroups cover ' : 'Keygroup ' + (index + 1) +
         ' covers ') + Akai.noteName(lo) + ' - ' + Akai.noteName(hi) +
        (lo === hi ? '  (one key)' : '  (' + (hi - lo + 1) + ' keys)') +
        '.  Unsaved changes - use Download image.');
  }

  function noteAt(c, ev) {
    var box = c.getBoundingClientRect();
    var x = ev.clientX - box.left, y = ev.clientY - box.top;
    var k = keyRects(c.clientWidth, c.clientHeight);
    if (y < k.top || y > k.top + k.kh) return -1;

    var n, r;
    for (n = k.lo; n <= k.hi; n++) {
      if (!isBlack(n)) continue;
      r = k.black(n);
      if (x >= r.x && x <= r.x + r.w && y <= r.y + r.h) return n;
    }
    for (n = k.lo; n <= k.hi; n++) {
      if (isBlack(n)) continue;
      r = k.white(n);
      if (x >= r.x && x <= r.x + r.w) return n;
    }
    return -1;
  }

  // ----------------------------------------------------------------- playback

  /**
   * Let go of the note. With an amplitude envelope in the chain this is the release,
   * not a cut: the gain ramps down over the keygroup's release time and the source is
   * stopped after it, so a long release rings on the way it does on the machine.
   */
  /** Let one voice go, over its own release. */
  /*
   * Swap the sounding buffer for one whose filter is closing.
   *
   * The machine's filter envelope has a release: letting go of a key closes the filter back
   * towards the keygroup's own cutoff while the level fades. This version bakes the filter
   * into the buffer at note-on, which can say nothing about a moment that has not happened
   * yet - so the tail is rendered here, when the key actually comes up, and started in place
   * of the buffer that was playing.
   *
   * The join is not a fade. The tail is primed with the samples leading up to it, so the
   * filter arrives holding the history the old buffer left it with, and the two meet
   * continuously. Returns true if the swap happened.
   */
  function spliceReleaseTail(v, g, at) {
    var tail = v.tail;
    if (!tail || !audio || !$('useVcf').checked) return false;

    var heldFor = at - tail.startedAt;
    if (heldFor < 0) heldFor = 0;

    // where playback had reached, in words, following the loop if there is one
    var pos = Math.round(heldFor * tail.fs);
    if (tail.loop && tail.loop.end > tail.loop.from && pos >= tail.loop.end) {
      var span = tail.loop.end - tail.loop.from;
      pos = tail.loop.from + ((pos - tail.loop.from) % span);
    }
    if (pos >= tail.words.length) return false;

    var samples;
    try {
      samples = AkaiAudio.releaseTail(tail.words, tail.fs, tail.kg, tail.zone,
                                      tail.note, tail.velocity, heldFor, pos, tail.loop,
                                      v.release + 0.05);
    } catch (err) { return false; }

    if (!samples || !samples.length) return false;      // no filter release on this keygroup

    try {
      var buf = audio.createBuffer(1, samples.length, tail.rate);
      buf.getChannelData(0).set(samples);

      var src = audio.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = tail.speed;
      src.connect(g);
      src.start(at);

      v.tailSrc = src;
      return true;
    } catch (err) {
      return false;
    }
  }

  function releaseVoice(key) {
    var v = voices[key];
    if (!v) return;
    delete voices[key];

    if (v.gain && v.release > 0.002 && audio) {
      var g = v.gain, src = v.src, t = audio.currentTime;

      try {
        // Read the gain BEFORE cancelling anything. cancelScheduledValues drops the
        // scheduled ramps and leaves .value reading back as the last value explicitly
        // set - which is the near-zero this note started from - so cancelling first and
        // reading after releases from silence to silence and is simply inaudible.
        var level = g.gain.value;

        if (g.gain.cancelAndHoldAtTime) {
          g.gain.cancelAndHoldAtTime(t);          // holds where the envelope actually is
        } else {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(level > 1e-4 ? level : 1e-4, t);
        }

        /*
         * An exponential ramp cannot start from zero, and cannot reach it either - so it is
         * aimed at 1e-4 and cut to silence just after.
         *
         * The TIME to get there is worked out from the rate, not taken as the release itself.
         * The release byte sets how fast the level falls - CAL.VCA_RELEASE_DB in one release
         * time, measured - so how long the note takes to die depends on how loud it was when
         * the key came up. Ramping to 1e-4 over exactly v.release made a quiet note fade at
         * the same wall-clock speed as a loud one, and made every release twice as fast as
         * the machine's into the bargain.
         */
        var fallDb = 20 * Math.log10(Math.max(level, 1e-4) / 1e-4);
        var fallFor = v.release * fallDb / AkaiAudio.CAL.VCA_RELEASE_DB;

        g.gain.exponentialRampToValueAtTime(1e-4, t + fallFor);
        g.gain.setValueAtTime(0, t + fallFor + 0.001);

        // The filter closes as the note dies, which needs the tail rendering now - see
        // spliceReleaseTail. If there is nothing to splice the buffer plays on as it was.
        var spliced = spliceReleaseTail(v, g, t);

        // fallFor, not v.release - the gain ramp now runs for as long as the RATE needs,
        // which is longer than one release time for anything above -40 dB. Stopping the
        // source at v.release would chop the tail off exactly where the old, twice-too-fast
        // release used to end.
        if (src) src.stop(spliced ? t : t + fallFor + 0.02);
        if (v.osc) v.osc.stop(t + fallFor + 0.02);
      } catch (e) {
        try { if (src) src.stop(); } catch (e2) { /* already finished */ }
        try { if (v.osc) v.osc.stop(); } catch (e3) { /* already finished */ }
        try { if (v.tailSrc) v.tailSrc.stop(); } catch (e4) { /* already finished */ }
      }
      return;
    }

    if (v.src) { try { v.src.stop(); } catch (e) { } }
    if (v.osc) { try { v.osc.stop(); } catch (e) { } }
    if (v.tailSrc) { try { v.tailSrc.stop(); } catch (e) { } }
  }

  /** Everything off - what the old single-voice stop() meant. */
  function stop() {
    Object.keys(voices).forEach(releaseVoice);
  }

  /** Oldest first, so a ninth note steals from the first rather than failing. */
  function makeRoom() {
    var keys = Object.keys(voices);
    if (keys.length < MAX_VOICES) return;

    keys.sort(function (a, b) { return voices[a].at - voices[b].at; });
    releaseVoice(keys[0]);
  }

  /**
   * `vcf`, when given, is { kg, zone, note, velocity }: the keygroup's whole voice is
   * applied - filter and amplitude envelope both - when the box is ticked.
   *
   * The filter is rendered into the buffer because its cutoff moves with the VCF
   * envelope, which no Web Audio node will do for a cascade. The amplitude envelope is a
   * GainNode instead, so that letting go of the key can release the note rather than cut
   * it. Filter before gain, which is the order the machine has them in.
   *
   * On the machine the filter sits after the varispeed, so its cutoff is a fixed number
   * of hertz whatever pitch the sample is playing at. Filtering the stored words at their
   * own rate and then pitching the result would drag the cutoff along with the pitch, so
   * the filter is run at the rate the audio actually leaves at - the sample rate times the
   * playback speed - and the buffer is then played back normally.
   */
  /*
   * The programme's own LFO, for keygroups with desync clear.
   *
   * One oscillator per distinct rate, made on demand and never stopped: it is a single
   * node whichever way, and stopping it would lose the phase that sharing exists to
   * preserve. A voice connects its depth gain to this instead of to one of its own, so
   * every note on the programme rides the same wobble.
   */
  var shared = {};

  function sharedLfo(ac, hz) {
    var at = hz.toFixed(3);
    if (!shared[at] || shared[at].ctx !== ac) {
      var o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      o.start();
      shared[at] = { osc: o, ctx: ac };
    }
    return shared[at].osc;
  }

  /*
   * A panner for a keygroup sent to LEFT or RIGHT, or null for everything else.
   *
   * Byte 19 is the output port: 0 ALL, 1..8 the individual mono sockets, 9 LEFT, 10 RIGHT.
   * 38 keygroups across four library programmes use LEFT or RIGHT and came out dead centre
   * here until now - TUBULAR 2 spreads its bells L L L L R R R R.
   *
   * Hard, not a pan law: those are two mono sockets on the back of the machine, so a keygroup
   * sent to one is absent from the other. MONO 1..8 stay centred, which is a placeholder and
   * not a measurement - what the main pair does with a voice routed to an individual output is
   * a question about hardware that no disk answers. Centring is what this always did.
   *
   * Returns null rather than a centred panner so that every other note keeps the graph it had.
   */
  function panFor(kg) {
    if (!kg || !audio) return null;
    if (kg.outputPort !== 9 && kg.outputPort !== 10) return null;
    if (!audio.createStereoPanner) return null;         // older WebKit

    var p = audio.createStereoPanner();
    p.pan.value = kg.outputPort === 9 ? -1 : 1;
    p.connect(out());
    return p;
  }

  function play(d, e, semitones, honourLoop, vcf, key, loopOver) {
    key = key === undefined ? 'preview' : key;
    var words = wordsOf(d, e);
    if (!words.length) return;

    releaseVoice(key);
    makeRoom();
    var ac = ctx();
    var rate = clamp(e.sampleRate, 3000, 96000);
    var speed = Math.pow(2, (semitones || 0) / 12);

    var filtered = vcf && vcf.kg && $('useVcf').checked;
    var buf;

    if (filtered) {
      buf = ac.createBuffer(1, words.length, rate);
      buf.getChannelData(0).set(
        AkaiAudio.applyVcf(words, rate * speed, vcf.kg, vcf.zone, vcf.note, vcf.velocity));
    } else {
      // the same samples every time, so the buffer is built once and shared by every
      // source that plays it
      var c = derivedFor(d);
      buf = c.buffers[e.slot];
      if (!buf) {
        buf = ac.createBuffer(1, words.length, rate);
        var ch = buf.getChannelData(0);
        for (var i = 0; i < words.length; i++) ch[i] = words[i] / 2048;
        c.buffers[e.slot] = buf;
      }
    }

    var src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speed;

    // `loopOver` is how the Find loop dialog auditions a loop before it is written
    var lp = loopOver || (e.loopMode !== 'O' && e.loopLength > 0
      ? { from: Math.max(e.loopStart, e.loopEnd - e.loopLength), end: e.loopEnd } : null);
    if (honourLoop && lp && lp.end > lp.from) {
      /*
       * An ALTERNATING loop, built into the buffer rather than played backwards.
       *
       * Web Audio's looper only goes forwards - there is no ping-pong mode and no way to
       * drive the read position by hand without giving up the native player entirely. So the
       * loop is written out twice, the second time reversed, and the native looper runs
       * forward over the pair. That is the same sound by construction, and it costs one
       * buffer copy at note-on instead of a ScriptProcessor for the life of the note.
       *
       * The lengths follow the hardware, measured in run 13: the reversed half begins with
       * the loop's LAST frame and ends with its FIRST, so both ends are played twice as the
       * direction turns and the cycle is 2N frames rather than 2N-2. Four loop lengths from
       * 20 frames to 128 autocorrelated at exactly 2N on the machine.
       *
       * The C# and C++ engines do it properly, by reflecting the read position - they own
       * their own resampler and can afford to. This is the browser's version of the same
       * answer, not a different one.
       */
      var pong = null;

      if (e.loopMode === 'A' && !loopOver) {
        var from = Math.max(0, Math.round(lp.from));
        var to = Math.min(Math.round(lp.end), buf.length);
        var n = to - from;

        if (n >= 2) {
          pong = ac.createBuffer(1, to + n, rate);
          var src0 = buf.getChannelData(0), dst = pong.getChannelData(0);

          dst.set(src0.subarray(0, to), 0);
          for (var r = 0; r < n; r++) dst[to + r] = src0[to - 1 - r];

          src.buffer = pong;
          src.loop = true;
          src.loopStart = from / e.sampleRate;
          src.loopEnd = (to + n) / e.sampleRate;
        }
      }

      if (!pong) {
        src.loop = true;
        src.loopStart = lp.from / e.sampleRate;
        src.loopEnd = Math.min(lp.end, words.length) / e.sampleRate;
      }
    }

    /*
     * The LFO: a sine on the playback rate, which is what the machine turned out to do.
     *
     * detune is in cents, which is exactly the unit the depth was measured in, so the
     * oscillator's output needs no conversion - a gain of N cents on a unit sine IS a
     * swing of N cents. The delay is a fade rather than a wait, so the gain ramps from
     * nothing rather than switching on.
     *
     * Skipped entirely when there is nothing to hear, which is most of the library: the
     * depth is zero in the great majority of keygroups, and an oscillator per voice for
     * a modulation of nothing is a waste of a node.
     */
    var osc = null;
    if (vcf && vcf.kg && $('useLfo').checked && src.detune) {
      var mod = AkaiAudio.lfo(vcf.kg, wheel);
      if (mod) {
        var t1 = ac.currentTime;

        // Desync clear means the voices share the programme's oscillator, so a note
        // joining a chord arrives at whatever phase the wobble has already reached.
        // Desync set gives each voice its own, starting where it starts - which is the
        // library's usual case, and on the machine those ran at slightly different
        // rates and drifted apart. Only the sharing is modelled; inventing a spread
        // from one measured pair would be making it up.
        var wave = mod.ownOscillator ? null : sharedLfo(ac, mod.hz);
        if (!wave) {
          osc = ac.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = mod.hz;
          wave = osc;
        }

        var depth = ac.createGain();
        if (mod.fadeSeconds > 0.01) {
          depth.gain.setValueAtTime(0, t1);
          depth.gain.linearRampToValueAtTime(mod.cents, t1 + mod.fadeSeconds);
        } else {
          depth.gain.value = mod.cents;
        }

        wave.connect(depth);
        depth.connect(src.detune);
        if (osc) osc.start();
      }
    }

    var env = (vcf && vcf.kg && $('useVcf').checked)
      ? AkaiAudio.vcaEnvelope(vcf.kg, vcf.zone, vcf.velocity) : null;

    if (env) {
      var g = ac.createGain();
      var t0 = ac.currentTime;
      var peak = Math.max(env.peak, 1e-4);
      var held = Math.max(peak * env.sustain, 1e-4);

      g.gain.setValueAtTime(1e-4, t0);
      if (env.attack > 0.002) g.gain.linearRampToValueAtTime(peak, t0 + env.attack);
      else g.gain.setValueAtTime(peak, t0);

      // The decay falls in a straight line in DECIBELS, which is what the hardware
      // does: a stored decay of 80 measured 2.9, 2.7, 3.0, 3.0, 2.7, 2.9 dB per fifth
      // of a second, dead constant for two and a half seconds. A linear ramp in
      // amplitude hangs near the peak and then falls off a cliff at the end, which is
      // audibly a different instrument. An exponential ramp is exactly the straight
      // line in dB, and Web Audio schedules it natively.
      if (env.decay > 0.002)
        g.gain.exponentialRampToValueAtTime(held, t0 + env.attack + env.decay);
      else g.gain.setValueAtTime(held, t0 + env.attack);

      /*
       * WARP: the pitch bend at note-on, if this keygroup has one.
       *
       * Scheduled as a value curve rather than setTargetAtTime, which is the obvious tool and
       * the wrong one. setTargetAtTime decays the RATE exponentially towards its target; the
       * machine decays the bend exponentially in CENTS, and the two are only the same for
       * small bends. At three semitones they part by about seven cents a time constant in,
       * which is audible on a tuned sample.
       *
       * Six time constants is the whole event - the bend is a quarter of a per cent of its
       * depth by then - and 200 points across it is finer than any bend here needs.
       */
      var warpC = AkaiAudio.warpCents(vcf.kg.warpVelocity, vcf.kg.warpDepth, vcf.velocity);

      if (warpC !== 0) {
        var tau = AkaiAudio.warpSeconds(vcf.kg.warpTime);
        var over = tau * 6, pts = 200;
        var curve = new Float32Array(pts);

        for (var w = 0; w < pts; w++)
          curve[w] = speed * Math.pow(2, (warpC * Math.exp(-(w / (pts - 1)) * over / tau)) / 1200);

        // A curve that collides with other automation throws rather than failing quietly;
        // nothing else touches playbackRate here, but a note that plays flat beats one that
        // does not play at all.
        try {
          src.playbackRate.setValueCurveAtTime(curve, t0, over);
          src.playbackRate.setValueAtTime(speed, t0 + over);
        } catch (err) {
          src.playbackRate.value = speed;
        }
      }

      src.connect(g);
      g.connect(panFor(vcf.kg) || out());
      voices[key] = { src: src, gain: g, osc: osc, release: env.release,
                      speed: speed, at: voiceSeq++ };
    } else {
      src.connect(out());
      voices[key] = { src: src, gain: null, osc: osc, release: 0,
                      speed: speed, at: voiceSeq++ };
    }

    /*
     * A note started while the wheel is already off centre starts bent.
     *
     * After the voice is registered rather than before, so applyBend can simply walk the
     * voices it knows about - one path for a note starting bent and for the wheel moving
     * under a note that is already sounding, instead of two that could drift apart.
     */
    if (pitchWheel !== 8192) applyBend();

    /*
     * What the voice needs to render its own filter release when the key comes up.
     *
     * The filter is baked into the buffer before the note starts, so the release - which is
     * not known until the key is let go - has to be rendered then and spliced on. Keeping
     * these here is what lets releaseVoice do that without going back to the disk.
     */
    if (filtered) {
      voices[key].tail = {
        words: words, fs: rate * speed, rate: rate, speed: speed,
        kg: vcf.kg, zone: vcf.zone, note: vcf.note, velocity: vcf.velocity,
        loop: src.loop ? { from: Math.round(src.loopStart * e.sampleRate),
                           end:  Math.round(src.loopEnd * e.sampleRate) } : null,
        startedAt: ac.currentTime
      };
    }

    src.start();
    return src;
  }

  function pitchFor(e, kg, zone, note) {
    var offset = zone ? zone.transpose + zone.fine / 256 : 0;
    if (kg.constantPitch) return offset;
    return (note - (e.nominalPitch + e.finePitch / 16)) + offset;
  }

  // ------------------------------------------------------------ adding a sample

  var imp = { buffer: null, disk: null, source: '' };

  /**
   * The browser decodes the audio - WAV, MP3, FLAC, AAC, Ogg, whatever it supports -
   * and an OfflineAudioContext does the mixdown to mono and the rate conversion,
   * which is a better resampler than one worth hand-writing.
   */
  function addSampleFrom(file) {
    var d = sel && sel.disk;
    if (!d) { say('Select a disk first.'); return; }

    say('Decoding ' + file.name + '...');

    file.arrayBuffer().then(function (buf) {
      return AkaiAudio.decode(ctx(), buf);
    }).then(function (decoded) {
      imp.buffer = decoded;
      imp.disk = d;
      imp.source = file.name;

      $('impSource').textContent = 'Source:  ' + Math.round(decoded.sampleRate).toLocaleString() +
        ' Hz, ' + (decoded.numberOfChannels === 1 ? 'mono' :
                   decoded.numberOfChannels === 2 ? 'stereo' : decoded.numberOfChannels + ' channels') +
        ', ' + decoded.duration.toFixed(2) + ' s' +
        (decoded.numberOfChannels > 1 ? '  -  will be mixed down to mono' : '');

      var rates = $('impRate');
      rates.textContent = '';
      var keep = Math.min(44100, Math.round(decoded.sampleRate));
      rates.appendChild(new Option('Keep ' + keep.toLocaleString() + ' Hz', String(keep)));
      AkaiAudio.RATES.forEach(function (r) {
        rates.appendChild(new Option(r.toLocaleString() + ' Hz', String(r)));
      });
      rates.selectedIndex = 0;

      $('impName').value = Akai.normaliseName(file.name.replace(/\.[^.]+$/, ''));
      $('impTrim').max = decoded.duration.toFixed(2);
      $('impTrim').value = decoded.duration.toFixed(2);
      $('impPitch').value = 60;
      $('impLoop').value = 'O';
      $('impNorm').checked = true;

      impRecalc();
      $('importDlg').showModal();
      say('');
    }).catch(function (e) {
      say('Could not read that file: ' + e.message);
    });
  }

  function impRate() { return parseInt($('impRate').value, 10) || 44100; }
  function impTrimSecs() {
    return clamp(parseFloat($('impTrim').value) || 0, 0.01, imp.buffer ? imp.buffer.duration : 0.01);
  }
  function impWords() { return Math.floor(impTrimSecs() * impRate()) & ~1; }

  /** The longest sample the free blocks can hold. */
  function impMaxWords() {
    var bytes = imp.disk.freeBlocks() * Akai.BLOCK - Akai.HEADER;
    return Math.max(0, Math.floor(bytes * 2 / 3)) & ~1;
  }

  function impNameTaken() {
    var want = Akai.normaliseName($('impName').value).toUpperCase();
    return imp.disk.entries.some(function (e) { return e.name.toUpperCase() === want; });
  }

  function impRecalc() {
    if (!imp.buffer) return;

    var words = impWords();
    var length = Akai.HEADER + words * 3 / 2;
    var need = Akai.blocksFor(length);
    var free = imp.disk.freeBlocks();
    var blank = !$('impName').value.trim();
    var taken = impNameTaken();
    var fits = need <= free && words >= 2;

    $('impPitchName').textContent = Akai.noteName(clamp(parseInt($('impPitch').value, 10) || 60, 0, 127));

    var text = fmt(words) + ' words at ' + fmt(impRate()) + ' Hz  =  ' +
               (words / impRate()).toFixed(2) + ' s,  ' + fmt(length) + ' bytes\n' +
               need + ' block' + (need === 1 ? '' : 's') + ' needed, ' + fmt(free) + ' free on this disk';

    if (!fits) text += '\n' + (words < 2
      ? 'Nothing left to add - raise the length.'
      : 'Too big for this disk. Shorten it, lower the rate, or use Trim to fit.');
    else if (blank) text += '\nGive the sample a name.';
    else if (taken) text += '\nThat name is already used on this disk.';

    $('impSummary').textContent = text;
    $('impSummary').classList.toggle('bad', !fits || blank || taken);
    $('impAdd').disabled = !fits || blank || taken;
    $('impFit').disabled = fits;
  }

  function impConvert() {
    var words = Math.min(impWords(), impMaxWords());
    return AkaiAudio.toMono(imp.buffer, impRate(), impTrimSecs(), words)
      .then(function (mono) {
        return AkaiAudio.to12Bit(mono.getChannelData(0), $('impNorm').checked);
      });
  }

  $('impFit').onclick = function () {
    // Resampling preserves duration, so the word limit converts to seconds directly.
    var secs = impMaxWords() / impRate() - 0.01;
    $('impTrim').value = Math.max(0.01, Math.min(imp.buffer.duration, secs)).toFixed(2);
    impRecalc();
  };

  $('impPreview').onclick = function () {
    impConvert().then(function (words) {
      stop();
      var ac = ctx();
      var src = ac.createBufferSource();
      src.buffer = AkaiAudio.bufferOf(ac, words, impRate());
      src.connect(out());
      src.start();
      voices['preview'] = { src: src, gain: null, release: 0, at: voiceSeq++ };
    });
  };

  $('impCancel').onclick = function () { $('importDlg').close(); };

  $('impAdd').onclick = function () {
    impConvert().then(function (words) {
      var d = imp.disk;
      pushUndo(d, 'add sample ' + $('impName').value);
      var added = d.addSample($('impName').value, words, impRate(),
                              clamp(parseInt($('impPitch').value, 10) || 60, 0, 127), 0,
                              $('impLoop').value);
      $('importDlg').close();
      buildTree();
      showFile(d, added, document.querySelector('[data-key="' + d.name + '/' + added.slot + '"]'));
      say('Added ' + added.name + '  -  ' + fmt(added.sampleCount) + ' words at ' +
          fmt(added.sampleRate) + ' Hz, ' + d.freeBlocks() + ' blocks free.  Unsaved changes.');
    }).catch(function (e) {
      say('Could not add that sample: ' + e.message);
    });
  };

  ['impTrim', 'impRate', 'impName', 'impPitch', 'impNorm', 'impLoop'].forEach(function (id) {
    $(id).addEventListener('input', impRecalc);
    $(id).addEventListener('change', impRecalc);
  });

  // -------------------------------------------------- sample operations

  function reselect(d, slot, msg) {
    d.parseDirectory();
    buildTree();
    for (var i = 0; i < d.entries.length; i++)
      if (d.entries[i].slot === slot) {
        showFile(d, d.entries[i],
                 document.querySelector('[data-key="' + d.name + '/' + slot + '"]'));
        break;
      }
    say(msg);
  }

  /**
   * Deleting a sample also empties every zone that named it and pulls back the
   * pointers of zones naming later samples, whose position in the table has just
   * shifted. The confirmation says exactly what will be affected.
   */
  function doDelete() {
    var d = sel.disk, e = sel.entry;
    if (!e || e.type !== 'S') return;

    var users = d.sampleUsers(e.name);
    var where = users.slice(0, 6).map(function (u) {
      return '    ' + u.program + '  keygroup ' + u.keygroup + ', zone ' + u.zone;
    }).join('\n');

    var msg = 'Delete ' + e.name + '?\n\n' +
      fmt(e.sampleCount) + ' words, ' + fmt(e.length) + ' bytes, ' +
      e.chainBlocks + ' block' + (e.chainBlocks === 1 ? '' : 's') + ' returned to the disk.\n\n' +
      (users.length
        ? users.length + ' keygroup zone' + (users.length === 1 ? '' : 's') +
          ' will be emptied:\n' + where +
          (users.length > 6 ? '\n    ... and ' + (users.length - 6) + ' more' : '') + '\n\n'
        : 'No program refers to it.\n\n') +
      'This cannot be undone except with Undo.';

    if (!confirm(msg)) return;

    try {
      pushUndo(d, 'delete ' + e.name);
      var r = d.deleteSample(e);

      sel = { disk: d, entry: null };
      buildTree();
      showDisk(d);
      say('Deleted ' + e.name + '  -  ' + r.blocksFreed + ' blocks freed, ' +
          r.cleared + ' zone' + (r.cleared === 1 ? '' : 's') + ' emptied, ' +
          r.repointed + ' reference' + (r.repointed === 1 ? '' : 's') + ' adjusted.  ' +
          'Unsaved changes.');
    } catch (err) {
      say('Could not delete: ' + err.message);
    }
  }

  function doRename() {
    var d = sel.disk, e = sel.entry;
    var name = prompt('Rename ' + e.name + ' to:', e.name);
    if (name === null) return;

    try {
      pushUndo(d, 'rename ' + e.name);
      var refs = d.renameFile(e, name);
      reselect(d, e.slot, 'Renamed to ' + Akai.normaliseName(name) +
        (refs ? '  -  ' + refs + ' keygroup reference' + (refs === 1 ? '' : 's') + ' updated' : '') +
        '.  Unsaved changes.');
    } catch (err) { say('Could not rename: ' + err.message); }
  }

  function doTrim() {
    var d = sel.disk, e = sel.entry;
    var plan = d.planTrim(e, AkaiAudio.SILENCE_THRESHOLD);

    if (!plan.anything) {
      say(e.name + ' has no silence at either end to remove.');
      return;
    }

    var what = [];
    if (plan.front) what.push(fmt(plan.front) + ' words (' + plan.seconds.toFixed(3) +
                             ' s) from the start');
    if (plan.back) what.push(fmt(plan.back) + ' words (' + plan.backSeconds.toFixed(3) +
                            ' s) from the end');

    if (!confirm(e.name + '\n\nRemoves  ' + what.join('\n         ') +
                 '\nWords    ' + fmt(e.sampleCount) + '  ->  ' + fmt(plan.newWords) +
                 '\nFrees    ' + plan.blocksFreed + ' block(s)\n\n' +
                 (plan.heldByLoop
                   ? 'The end is cut back to the loop end and no further, so the loop ' +
                     'still has its audio.\n'
                   : '') +
                 'Markers move with the audio.')) return;

    try {
      pushUndo(d, 'trim ' + e.name);
      var freed = d.trimSample(e, AkaiAudio.SILENCE_THRESHOLD);
      reselect(d, e.slot, 'Trimmed ' + what.join(' and ') + ' of ' + e.name +
               '  -  ' + freed + ' blocks freed.  Unsaved changes.');
    } catch (err) { say('Could not trim: ' + err.message); }
  }

  function doHalve() {
    var d = sel.disk, e = sel.entry;
    var newRate = Math.floor(e.sampleRate / 2);

    if (newRate < AkaiAudio.MIN_RATE) {
      say(e.name + ' is at ' + fmt(e.sampleRate) + ' Hz; halving it would give ' +
          fmt(newRate) + ' Hz, below the ' + fmt(AkaiAudio.MIN_RATE) + ' Hz the S950 will run.');
      return;
    }
    if (!confirm(e.name + '\n\nRate   ' + fmt(e.sampleRate) + '  ->  ' + fmt(newRate) + ' Hz\n' +
                 'Words  ' + fmt(e.sampleCount) + '  ->  ' + fmt(Math.floor(e.sampleCount / 2)) +
                 '\n\nPitch and duration are unchanged; it loses its top octave.')) return;

    say('Halving ' + e.name + '...');
    AkaiAudio.halveRate(d.sampleWords12(e), e.sampleRate).then(function (words) {
      pushUndo(d, 'halve ' + e.name);
      var freed = d.replaceSampleAudio(e, words, newRate);
      reselect(d, e.slot, 'Halved ' + e.name + ' to ' + fmt(newRate) + ' Hz  -  ' +
               freed + ' blocks freed.  Unsaved changes.');
    }).catch(function (err) { say('Could not halve: ' + err.message); });
  }

  function doStretch() {
    var d = sel.disk, e = sel.entry;
    var from = parseFloat(prompt('Tempo the sample is at (BPM):', '120'));
    if (!from) return;
    var to = parseFloat(prompt('Tempo to play it at (BPM):', String(from)));
    if (!to) return;

    var ratio = from / to;
    var words = Math.floor(d.sampleWords12(e).length * ratio) & ~1;
    var need = Akai.blocksFor(Akai.HEADER + words * 3 / 2) - Akai.blocksFor(e.length);

    if (need > d.freeBlocks()) {
      say('Too big: needs ' + need + ' more blocks, ' + d.freeBlocks() + ' free.');
      return;
    }
    if (!confirm(e.name + '\n\n' + from + ' -> ' + to + ' BPM\nWords  ' + fmt(e.sampleCount) +
                 '  ->  ' + fmt(words) + '\n' +
                 (need > 0 ? 'Needs ' + need + ' more block(s)' :
                  need < 0 ? 'Frees ' + (-need) + ' block(s)' : 'Same size') +
                 '\n\nPitch is preserved.')) return;

    say('Stretching ' + e.name + '...');
    setTimeout(function () {
      try {
        var out = AkaiAudio.timeStretch(d.sampleWords12(e), ratio);
        pushUndo(d, 'stretch ' + e.name);
        d.replaceSampleAudio(e, out, e.sampleRate);
        reselect(d, e.slot, e.name + ' stretched to ' + fmt(out.length) +
                 ' words.  Unsaved changes.');
      } catch (err) { say('Could not stretch: ' + err.message); }
    }, 10);
  }

  // ------------------------------------------------------------------- events

  $('pick').onchange = function () { openFiles(this.files); this.value = ''; };

  /**
   * Start an empty disk. It lives in the page like any other, and is marked unsaved
   * from the moment it appears, because unlike the others it has no file behind it:
   * closing the tab is the only way to lose work that was never anywhere else.
   */
  $('newImage').onclick = function () {
    var n = 1, name;
    do {
      name = n === 1 ? 'new-disk.img' : 'new-disk-' + n + '.img';
      n++;
    } while (disks.some(function (d) { return d.name === name; }));

    var made = Akai.blank(name);
    made.isNew = true;              // so Download image does not suggest "-edited"
    made.modified = true;
    disks.push(made);

    finish([]);
    showDisk(made);

    say('Started ' + name + ' - 800K, empty, ' + made.freeBlocks() + ' blocks free.  ' +
        'Add a program or a sample, then Download image. It exists only in this page ' +
        'until you do.');
  };
  $('audioPick').onchange = function () {
    if (this.files && this.files[0]) addSampleFrom(this.files[0]);
    this.value = '';
  };

  /**
   * Builds the download filename from what the user typed. The extension follows
   * the image rather than the typing: an HFE stays .hfe and a raw sector image
   * stays .img, whichever of the two was typed or none at all.
   */
  function downloadName(typed, isHfe, fallback) {
    var ext = isHfe ? '.hfe' : '.img';
    var name = (typed || '').trim()
      .replace(/\.(hfe|img)$/i, '')
      .replace(/[\\\/:*?"<>|]/g, '-')      // not legal in a filename
      .trim();

    return (name || fallback) + ext;
  }

  $('save').onclick = doSave;


  // ------------------------------------------------------------------ MIDI in
  //
  // Playing the emulation from a sequencer, so the same part can be sent to this and to
  // the sampler and the two compared. Notes go to whichever program is selected: the
  // keygroup covering the note decides the sample, the tuning and the whole voice, just
  // as a key press on the on-screen keyboard does.
  //
  // Web MIDI is only granted on a secure context, so this works over http://localhost
  // (serve.js) or https, and is refused outright on a file:// page - which is worth
  // saying plainly, because the failure is otherwise a silent empty list.

  var midiAccess = null, midiPort = null;

  function midiChannel() {
    var v = $('midiCh').value;
    return v === '' ? -1 : parseInt(v, 10);          // -1 is omni
  }

  /*
   * The sample a keygroup answers a strike with, and the zone it came from.
   *
   * The velocity switch decides, exactly as it does in the plugin and in the desktop engine -
   * see Akai.zoneForVelocity. This page used to ignore it entirely: it played zone 1 and
   * reached for zone 2 only when zone 1's sample was missing from the disk, so a two-zone
   * programme never sounded its hard sample however hard you played, and the two velocity
   * halves of every such keygroup were the same sound.
   *
   * The missing-sample fallback stays, because a keygroup naming a sample that is not on the
   * disk is better heard through its other zone than not at all - but it is a fallback now
   * rather than the whole rule.
   */
  function zoneSample(disk, kg, velocity) {
    var wanted = Akai.zoneForVelocity(kg, velocity);
    var s = findSample(disk, wanted.name);
    if (s) return { zone: wanted, sample: s };

    var other = wanted === kg.zone1 ? kg.zone2 : kg.zone1;
    if (other && other.inUse) {
      s = findSample(disk, other.name);
      if (s) return { zone: other, sample: s };
    }
    return null;
  }

  /** The keygroup covering a note in the selected program, with the sample that velocity picks. */
  function voiceFor(note, velocity) {
    if (!sel || !sel.entry || sel.entry.type !== 'P') return null;

    var kgs = keygroupsOf(sel.disk, sel.entry);
    for (var i = 0; i < kgs.length; i++) {
      var kg = kgs[i];
      if (note < Math.min(kg.lowKey, kg.highKey) || note > Math.max(kg.lowKey, kg.highKey)) continue;

      var picked = zoneSample(sel.disk, kg, velocity);
      if (picked) return { kg: kg, zone: picked.zone, sample: picked.sample, index: i };
    }
    return null;
  }

  // A note that cannot sound has to say why. There are three quite different reasons -
  // no program selected, a program whose keygroups do not reach that note, or a keygroup
  // naming a sample that is not on the disk - and they are indistinguishable from silence.
  function midiNoteOn(note, velocity) {
    var name = Akai.noteName(note) + ' (' + note + ')';

    if (!sel || !sel.entry) {
      say('MIDI ' + name + ' arrived, but nothing is selected. Open a disk and click a ' +
          'program in the list on the left.');
      return;
    }

    if (sel.entry.type !== 'P') {
      say('MIDI ' + name + ' arrived, but ' + sel.entry.name.trim() + ' is a ' +
          sel.entry.typeName + '. Notes need a program - click one in the list on the left.');
      return;
    }

    var v = voiceFor(note, velocity);
    if (!v) {
      say('MIDI ' + name + ' arrived, but no keygroup in ' + sel.entry.name.trim() +
          ' covers it. ' + keyRangeOf(sel.entry));
      return;
    }

    play(sel.disk, v.sample, pitchFor(v.sample, v.kg, v.zone, note),
         $('useLoop').checked,
         { kg: v.kg, zone: v.zone, note: note, velocity: velocity },
         'midi:' + note);

    say(name + '  ->  keygroup ' + (v.index + 1) + ', ' + v.sample.name.trim() +
        '   velocity ' + velocity);
  }

  /** Which notes a program will actually answer, for when one does not sound. */
  function keyRangeOf(p) {
    var kgs = sel.disk.keygroups(p);
    if (!kgs.length) return 'It has no keygroups.';

    var lo = 127, hi = 0;
    kgs.forEach(function (kg) {
      lo = Math.min(lo, kg.lowKey, kg.highKey);
      hi = Math.max(hi, kg.lowKey, kg.highKey);
    });
    return 'It answers ' + Akai.noteName(lo) + ' to ' + Akai.noteName(hi) +
           ' (' + lo + '-' + hi + '), not always continuously.';
  }

  /*
   * Where the modwheel is, 0..127.
   *
   * Held here rather than read from a control, because it is a performance gesture: the
   * S950 adds LFO depth in proportion to it, and 427 keygroups of 1908 set byte 22 to
   * something other than the default. A note already sounding keeps the depth it started
   * with - the machine does not, but chasing a moving wheel through a scheduled ramp buys
   * very little for the noise it would add here.
   */
  var wheel = 0;

  /*
   * Where the pitch wheel is, 0..16383 with 8192 at rest, and how far it bends.
   *
   * Unlike the modwheel above, this one DOES reach notes already sounding - that is the whole
   * point of a pitch wheel, and a bend that only applied to the next note would be useless.
   * Every voice keeps its source node, so moving the wheel walks them and sets the playback
   * rate; a note started while the wheel is off centre picks the bend up at note-on.
   *
   * The range is the machine's MIDI page setting, 1 to 12 semitones. It belongs to the machine
   * rather than to a programme, so there is nothing on a disk to read it from.
   */
  var pitchWheel = 8192;
  var bendRange = 2;

  if ($('bendRange'))
    $('bendRange').onchange = function () {
      bendRange = parseInt($('bendRange').value, 10) || 2;
      applyBend();                 // a note already sounding follows the new range at once
    };

  function applyBend() {
    var ratio = AkaiAudio.bendRatio(pitchWheel, bendRange);

    Object.keys(voices).forEach(function (k) {
      var v = voices[k];
      if (!v || !v.src || !v.speed) return;
      try { v.src.playbackRate.value = v.speed * ratio; } catch (e) { /* already stopped */ }
    });
  }

  function onMidi(ev) {
    var d = ev.data;
    if (!d || d.length < 2) return;

    var status = d[0] & 0xF0, chan = d[0] & 0x0F;
    var want = midiChannel();
    if (want >= 0 && chan !== want) return;

    // a note-on at velocity 0 is a note-off, which most sequencers send
    if (status === 0x90 && d[2] > 0) midiNoteOn(d[1], d[2]);
    else if (status === 0x80 || (status === 0x90 && d[2] === 0)) releaseVoice('midi:' + d[1]);
    else if (status === 0xB0 && d[1] === 1) wheel = d[2];                 // modwheel
    else if (status === 0xE0 && d.length >= 3) {                          // pitch wheel
      pitchWheel = (d[2] << 7) | (d[1] & 0x7F);
      applyBend();
    }
    else if (status === 0xB0 && (d[1] === 120 || d[1] === 123)) stop();   // all notes off
  }

  function listMidiPorts() {
    var pick = $('midiIn');
    var was = pick.value;
    pick.textContent = '';
    pick.appendChild(new Option('MIDI in: off', ''));

    if (midiAccess)
      midiAccess.inputs.forEach(function (port) {
        pick.appendChild(new Option(port.name, port.id));
      });

    pick.value = was;
    if (pick.value !== was) selectMidiPort('');
  }

  function selectMidiPort(id) {
    if (midiPort) { midiPort.onmidimessage = null; midiPort = null; }
    stop();

    if (!id || !midiAccess) { say('MIDI in off.'); return; }

    midiAccess.inputs.forEach(function (port) {
      if (port.id === id) { midiPort = port; port.onmidimessage = onMidi; }
    });

    if (midiPort)
      say('Listening to ' + midiPort.name + ' on ' +
          (midiChannel() < 0 ? 'all channels' : 'channel ' + (midiChannel() + 1)) +
          '.  Select a program, and play.');
  }

  (function initMidi() {
    var ch = $('midiCh');
    if (!ch) return;

    ch.appendChild(new Option('all channels', ''));
    for (var i = 0; i < 16; i++) ch.appendChild(new Option('channel ' + (i + 1), i));
    ch.value = '0';

    $('midiIn').onchange = function () { selectMidiPort(this.value); };
    ch.onchange = function () { if (midiPort) selectMidiPort(midiPort.id); };

    if (!navigator.requestMIDIAccess) {
      $('midiIn').disabled = true;
      $('midiIn').title = location.protocol === 'file:'
        ? 'Web MIDI needs the page served over http or https. Run: node serve.js'
        : 'This browser does not support Web MIDI.';
      return;
    }

    navigator.requestMIDIAccess().then(function (access) {
      midiAccess = access;
      access.onstatechange = listMidiPorts;
      listMidiPorts();

      // Windows has no way to pass MIDI between applications on its own. A sequencer can
      // reach a hardware interface, but nothing of its own appears here as an input, so
      // the list being empty - or holding only a physical keyboard - is the normal state
      // and not a fault. A virtual port is what bridges the two.
      var n = 0;
      access.inputs.forEach(function () { n++; });

      if (!n)
        say('MIDI is available but no inputs were found. A sequencer cannot reach this ' +
            'page directly on Windows - install a virtual MIDI port such as loopMIDI, ' +
            'send to it from the sequencer, and pick it here.');
      else
        say(n + ' MIDI input' + (n === 1 ? '' : 's') + ' found. Pick one, select a program, ' +
            'and play. To play from a sequencer you need a virtual port it can send to.');
    }, function () {
      $('midiIn').disabled = true;
      $('midiIn').title = 'MIDI access was refused.';
    });
  }());


  // --------------------------------------------------------------- downloading
  //
  // Two containers, either way round. IMG is the bare 800K sector image - what the tool
  // has been editing all along, so writing it is a copy. HFE is written by patching the
  // bitstream the disk arrived in, or, for a disk opened from a raw image, by building
  // the whole container: the encoder reproduces the library's own HFEs byte for byte,
  // so a converted disk is indistinguishable from one the Akai drive wrote.

  var saveDisk = null;

  function saveFormat() { return $('svImg').checked ? 'img' : 'hfe'; }

  function refreshSave() {
    if (!saveDisk) return;

    var fmt = saveFormat();
    $('svExt').textContent = '.' + fmt;

    var note;
    if (fmt === 'img') {
      note = fmt6(800 * Akai.BLOCK) + ' bytes  -  80 cylinders x 2 sides x 5 sectors of ' +
        '1024 bytes. FlashFloppy may need that geometry telling it; HFE carries it inside ' +
        'the file.';
    } else if (saveDisk.rawHfe) {
      note = fmt6(saveDisk.rawHfe.length) + ' bytes  -  the container this disk was opened ' +
        'from, with its sectors rewritten in place.';
    } else {
      note = '2,008,064 bytes  -  built from the sectors. The encoder reproduces the ' +
        'original disks byte for byte, so this is the same file an Akai drive would write.';
    }

    $('svSummary').textContent = note;
    $('svSummary').classList.remove('bad');
  }

  function fmt6(n) { return (n | 0).toLocaleString(); }

  function doSave() {
    var d = sel && sel.disk;
    if (!d) return;

    saveDisk = d;

    $('svHfe').disabled = false;
    $('svHfe').checked = true;
    $('svImg').checked = false;

    $('svSource').textContent = d.name + (d.rawHfe ? '' :
      '  -  opened from a raw image; an HFE will be built for it');

    $('svName').value = d.name.replace(/\.[^.]+$/, '') + (d.isNew ? '' : '-edited');
    $('saveDlg').showModal();
    refreshSave();
    $('svName').focus();
  }

  if ($('svHfe')) $('svHfe').onchange = refreshSave;
  if ($('svImg')) $('svImg').onchange = refreshSave;
  if ($('svCancel')) $('svCancel').onclick = function () {
    $('saveDlg').close();
    saveDisk = null;
  };

  if ($('svGo')) $('svGo').onclick = function () {
    if (!saveDisk) return;

    var d = saveDisk, fmt = saveFormat();
    var fallback = d.name.replace(/\.[^.]+$/, '') + (d.isNew ? '' : '-edited');
    var file = downloadName($('svName').value, fmt === 'hfe', fallback);

    $('saveDlg').close();
    saveDisk = null;

    say('Rebuilding ' + d.name + '...');
    setTimeout(function () {
      var bytes;
      try { bytes = d.save(fmt); }
      catch (err) { say('Could not write that format: ' + err.message); return; }

      var blob = new Blob([bytes], { type: 'application/octet-stream' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      say('Wrote ' + file + '  (' + fmt6(bytes.length) + ' bytes)');
    }, 10);
  };

  $('kgAdd').onclick = function () {
    try {
      pushUndo(sel.disk, 'add keygroup ' + (sel.disk.keygroupCount(sel.entry) + 1));
      var now = sel.disk.addKeygroup(sel.entry, Math.max(0, selKeygroup));
      selKeygroup = now - 1;
      selSet = [selKeygroup];       // the new one, on its own
      selAnchor = selKeygroup;
      refreshKeygroups();
      say('Added keygroup ' + now + '.  Unsaved changes.');
    } catch (e) { say('Could not add a keygroup: ' + e.message); }
  };

  // The whole selection goes, highest first, so the indices below each delete still
  // point where they did when the list was drawn.
  // ------------------------------------------- copying a keygroup to a program

  var kgCopyFrom = null;        // { disk, program, index } while the chooser is open

  /*
   * Copy one keygroup onto another program, here or on another open disk.
   *
   * The chooser lists every program that is open except the one being copied from -
   * copying a keygroup onto its own program is what Add already does.
   */
  $('kgCopy').onclick = function () {
    if (!sel || !sel.entry || sel.entry.type !== 'P' || selKeygroup < 0) return;

    kgCopyFrom = { disk: sel.disk, program: sel.entry, index: selKeygroup };

    var pick = $('kgTarget');
    pick.innerHTML = '';

    disks.forEach(function (d, di) {
      d.entries.filter(function (e) { return e.type === 'P'; }).forEach(function (p) {
        if (d === sel.disk && p.slot === sel.entry.slot) return;

        var o = document.createElement('option');
        o.value = di + ':' + p.slot;
        o.textContent = d.name.replace(/\.(hfe|img)$/i, '') + '      ' + p.name.trim() +
                        '   (' + d.keygroupCount(p) + ' keygroups)';
        pick.appendChild(o);
      });
    });

    if (!pick.options.length) {
      say('There is no other program to copy it into. Create one, or open another disk image.');
      kgCopyFrom = null;
      return;
    }

    pick.selectedIndex = 0;

    $('kgSource').textContent =
      'Keygroup ' + (selKeygroup + 1) + ' of ' + sel.entry.name.trim() +
      ' on ' + sel.disk.name.replace(/\.(hfe|img)$/i, '');

    kgPreview();
    $('kgDlg').showModal();
  };

  $('kgTarget').onchange = kgPreview;
  $('kgCancel').onclick = function () { $('kgDlg').close(); kgCopyFrom = null; };

  /** Which program the chooser is pointing at, or null. */
  function kgChosen() {
    var pick = $('kgTarget');
    if (!kgCopyFrom || pick.selectedIndex < 0) return null;

    var bits = pick.value.split(':');
    var d = disks[parseInt(bits[0], 10)];
    if (!d) return null;

    var p = d.entryInSlot(parseInt(bits[1], 10));
    return p && p.type === 'P' ? { disk: d, program: p } : null;
  }

  /** What the copy would cost, shown before it is made rather than after. */
  function kgPreview() {
    var into = kgChosen();
    if (!into) { $('kgSummary').textContent = ''; return; }

    var plan;
    try {
      plan = into.disk.planCopyKeygroup(
        kgCopyFrom.disk, kgCopyFrom.program, kgCopyFrom.index, into.program);
    } catch (err) {
      $('kgSummary').textContent = 'Could not work it out: ' + err.message;
      $('kgGo').disabled = true;
      return;
    }

    $('kgGo').disabled = !plan.ok;

    if (!plan.ok) { $('kgSummary').textContent = plan.problems.join('  '); return; }

    var where = into.disk.name.replace(/\.(hfe|img)$/i, '');
    var bits = [];

    plan.samples.forEach(function (i) {
      if (i.alreadyHere) bits.push(i.from + ' is already on ' + where);
      else if (i.renamed) bits.push(i.from + ' comes too, as ' + i.to + ' (that name is taken)');
      else bits.push(i.to + ' comes with it');
    });

    if (!bits.length) bits.push('Everything it names is already on ' + where + '.');

    bits.push('Takes ' + plan.blocks + ' of the ' + into.disk.freeBlocks() +
              ' block(s) free on ' + where + '.');

    plan.notes.forEach(function (n) { bits.push(n + '.'); });

    $('kgSummary').textContent = bits.join('   -   ');
  }

  $('kgGo').onclick = function () {
    var into = kgChosen();
    if (!into || !kgCopyFrom) return;

    var from = kgCopyFrom;
    var where = into.disk.name.replace(/\.(hfe|img)$/i, '');
    var name = into.program.name.trim();
    var targetSlot = into.program.slot;

    var plan;
    try {
      plan = into.disk.planCopyKeygroup(from.disk, from.program, from.index, into.program);
    } catch (err) { say('Could not work out the copy: ' + err.message); return; }

    if (!plan.ok) { say('Cannot copy it into ' + name + ':  ' + plan.problems.join('  ')); return; }

    $('kgDlg').close();
    kgCopyFrom = null;

    try {
      pushUndo(into.disk, 'copy keygroup into ' + name);

      var number = into.disk.applyCopyKeygroup(plan);

      var msg = 'Copied keygroup ' + (from.index + 1) + ' of ' + from.program.name.trim() +
                ' into ' + name + ' on ' + where + ' as keygroup ' + number;

      if (plan.writes.length)
        msg += '  -  ' + plan.writes.length + ' sample' +
               (plan.writes.length === 1 ? '' : 's') + ' came with it';

      var renamed = plan.samples.filter(function (i) { return i.renamed; }).length;
      if (renamed) msg += ', ' + renamed + ' renamed to avoid a clash';

      reselect(into.disk, targetSlot, msg + '.  Unsaved changes.');
    } catch (err) {
      say('Could not copy the keygroup: ' + err.message);
      buildTree();
    }
  };

  $('kgDel').onclick = function () {
    var going = editTargets().sort(function (a, b) { return b - a; });
    if (!going.length) return;
    try {
      pushUndo(sel.disk, going.length > 1 ? 'delete ' + going.length + ' keygroups'
                                         : 'delete keygroup ' + (going[0] + 1));
      var now = 0;
      going.forEach(function (i) { now = sel.disk.deleteKeygroup(sel.entry, i); });
      selKeygroup = Math.min(going[going.length - 1], now - 1);
      selSet = [selKeygroup];
      selAnchor = selKeygroup;
      refreshKeygroups();
      say((going.length > 1 ? 'Deleted ' + going.length + ' keygroups' :
           'Deleted keygroup ' + (going[0] + 1)) + '.  Unsaved changes.');
    } catch (e) { say('Could not delete that keygroup: ' + e.message); }
  };

  $('vcfAmt').oninput = function () {
    var v = parseInt(this.value, 10) || 0;
    if (selKeygroup >= 0) pushUndo(sel.disk, editLabel('VCF amount'), true);
    $('vcfAmtLabel').innerHTML = 'amt<br>' + (v > 0 ? '+' : '') + v;
    if (selKeygroup < 0) return;
    writeAll(23, v);
    touched(editLabel('VCF amount'));
  };
  $('vcfAmt').onchange = function () { refreshKeygroups(); };

  $('play').onclick = function () {
    if (!sel || !waveEntry) return;

    // A keygroup carries the filter; a sample on its own has none to apply.
    var vcf = null;
    if (sel.entry && sel.entry.type === 'P' && selKeygroup >= 0) {
      var kgs = sel.disk.keygroups(sel.entry);
      var kg = kgs[selKeygroup];
      if (kg) vcf = { kg: kg, zone: kg.zone1, note: kg.lowKey, velocity: strikeVelocity() };
    }
    play(sel.disk, waveEntry, 0, $('useLoop').checked, vcf);
  };
  $('stop').onclick = stop;

  $('piano').addEventListener('mousemove', function (ev) {
    var n = noteAt(this, ev);
    if (n === hoverNote) return;
    hoverNote = n;
    this.style.cursor = setRange.on ? 'crosshair' : groupAt(n) >= 0 ? 'pointer' : 'default';
    drawPiano();
  });

  $('piano').addEventListener('mouseleave', function () {
    releaseVoice('preview');                  // sliding off the keyboard lets the note go
    if (hoverNote < 0) return;
    hoverNote = -1;
    drawPiano();
  });

  // anywhere, not just over the key: the button may come up off the canvas
  window.addEventListener('mouseup', function () { releaseVoice('preview'); });

  $('piano').addEventListener('mousedown', function (ev) {
    if (setRange.on) { takeRangeClick(noteAt(this, ev)); return; }
    var note = noteAt(this, ev);
    var grp = groupAt(note);
    if (grp < 0 || !sel || !sel.entry || sel.entry.type !== 'P') return;

    pickKeygroup(grp);

    var kgs = sel.disk.keygroups(sel.entry);
    var kg = kgs[grp];

    // The strip beside the keyboard decides which zone answers, the same as a MIDI note would
    var velocity = strikeVelocity();
    var picked = zoneSample(sel.disk, kg, velocity);
    if (!picked) { say('Keygroup ' + (grp + 1) + "'s sample is not on this disk."); return; }

    var zone = picked.zone, s = picked.sample;

    var shift = pitchFor(s, kg, zone, note);
    play(sel.disk, s, shift, $('useLoop').checked,
         { kg: kg, zone: zone, note: note, velocity: velocity });
    say('Playing ' + s.name + ' at ' + Akai.noteName(note) + '  -  ' +
        (shift >= 0 ? '+' : '') + shift.toFixed(2) + ' semitones' +
        (kg.constantPitch ? '  (constant pitch)' : ''));
  });

  /*
   * How hard the keyboard strikes.
   *
   * It used to be a fixed 100, which is not a neutral choice: velocity opens the filter,
   * and at the measured 8.34 octaves across the range with a pivot of 65, a strike of 100
   * sits about 1.2 octaves above it. On a programme written with any velocity-to-filter at
   * all that is the difference between hearing the filter and not. It lifts the level too,
   * 0.63 dB per step, so a softer strike is quieter as well as darker.
   */
  function strikeVelocity() {
    var v = parseInt($('velocity').value, 10);
    return v >= 1 && v <= 127 ? v : 100;
  }

  $('velocity').oninput = function () {
    $('velocityVal').textContent = strikeVelocity();
  };

  $('velocity').onchange = function () {
    say('Keyboard velocity ' + strikeVelocity() +
        '  -  a softer strike closes the filter, a harder one opens it.');
  };

  $('undo').onclick = function () { step(undoStack, redoStack, 'Undid'); };
  $('redo').onclick = function () { step(redoStack, undoStack, 'Redid'); };

  window.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && setRange.on) { ev.preventDefault(); disarmRange(); return; }
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
    var k = ev.key.toLowerCase();
    if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); $('undo').click(); }
    else if (k === 'y' || (k === 'z' && ev.shiftKey)) { ev.preventDefault(); $('redo').click(); }
  });

  $('opRenameFile').onclick = doRename;

  // --------------------------------------------------- copying between disks

  /*
   * The Copy to picker: every other disk that is open.
   *
   * Hidden rather than disabled when nothing else is loaded. There is nothing to choose
   * between, and a dropdown holding only its own prompt invites a click that cannot do
   * anything.
   */
  function fillCopyTo(d, e) {
    var pick = $('opCopyTo');
    var others = disks.filter(function (x) { return x !== d; });

    pick.hidden = !(e && (e.type === 'S' || e.type === 'P')) || others.length === 0;
    pick.innerHTML = '';

    var head = document.createElement('option');
    head.value = '';
    head.textContent = 'Copy to...';
    pick.appendChild(head);

    others.forEach(function (x) {
      var o = document.createElement('option');
      o.value = String(disks.indexOf(x));
      o.textContent = x.name.replace(/\.(hfe|img)$/i, '');
      pick.appendChild(o);
    });

    pick.value = '';
  }

  $('opCopyTo').onchange = function () {
    var pick = $('opCopyTo');
    var target = disks[parseInt(pick.value, 10)];

    pick.value = '';              // back to the prompt, whatever happens next

    if (!target || !sel || !sel.entry) return;
    doCopyTo(sel.disk, sel.entry, target);
  };

  /*
   * Copy a sample or a program onto another open disk.
   *
   * The plan is worked out and shown before anything is written, because a copy can
   * quietly be bigger than it looks: a program brings every sample its zones name, and one
   * of those can already be there under the same name holding something else. Nothing on
   * the target is ever replaced - a clash is renamed - so the worst case is a file you did
   * not want rather than one you cannot get back.
   */
  function doCopyTo(from, entry, target) {
    var where = target.name.replace(/\.(hfe|img)$/i, '');
    var plan;

    try { plan = target.planCopy(from, entry); }
    catch (err) { say('Could not work out the copy: ' + err.message); return; }

    if (!plan.ok) { say('Will not fit on ' + where + ':  ' + plan.problems.join('  ')); return; }

    if (plan.writes.length === 0) {
      say(entry.name.trim() + ' is already on ' + where +
          ', with everything it needs.  Nothing copied.');
      return;
    }

    var lines = plan.items.map(function (i) {
      var what = i.type === 'P' ? 'program' : 'sample ';
      if (i.alreadyHere) return '   ' + what + '  ' + i.from + '  -  already there, left alone';
      if (i.renamed) return '   ' + what + '  ' + i.from + '  ->  ' + i.to +
                            '   (that name is taken by something else)';
      return '   ' + what + '  ' + i.to;
    });

    var msg = 'Copy to ' + where + ':\n\n' + lines.join('\n') +
              '\n\nTakes ' + plan.blocks + ' of the ' + target.freeBlocks() +
              ' block(s) free on ' + where + '.';

    if (plan.notes.length) msg += '\n\n' + plan.notes.join('\n') + '.';

    if (!confirm(msg)) return;

    try {
      pushUndo(target, 'copy ' + entry.name.trim() + ' to ' + where);

      var landed = target.applyCopy(plan);

      // Land on what arrived - the program if one came, else the sample.
      var show = landed.filter(function (x) { return x.type === entry.type; })[0] ||
                 landed[landed.length - 1];

      var extra = '';
      if (entry.type === 'P' && plan.sampleWrites > 0)
        extra += ' with ' + plan.sampleWrites + ' sample' + (plan.sampleWrites === 1 ? '' : 's');

      var reused = plan.items.filter(function (i) { return i.alreadyHere; }).length;
      if (reused) extra += '  -  ' + reused + ' already there';

      var renamed = plan.items.filter(function (i) { return i.renamed; }).length;
      if (renamed) extra += '  -  ' + renamed + ' renamed to avoid a clash';

      reselect(target, show.slot,
               'Copied ' + entry.name.trim() + ' to ' + where + extra + '.  Unsaved changes.');
    } catch (err) {
      say('Could not copy: ' + err.message);
      buildTree();
    }
  }
  $('opDelete').onclick = function () {
    if (!sel || !sel.entry) return;
    if (sel.entry.type === 'P') doDeleteProgram(); else doDelete();
  };
  $('newProgram').onclick = doNewProgram;

  // --------------------------------------------------- programs: create and remove

  function doNewProgram() {
    var d = sel && sel.disk;
    if (!d) { say('Select a disk first.'); return; }

    var name = prompt('Name for the new program:', 'NEW PROG');
    if (name === null) return;

    name = Akai.normaliseName(name);
    if (!name) { say('A program needs a name.'); return; }

    try {
      pushUndo(d, 'new program ' + name);
      var p = d.addProgram(name);

      buildTree();
      reselect(d, p.slot, 'Created ' + p.name.trim() +
        ' with one empty keygroup across the keyboard.  Unsaved changes.');
    } catch (err) {
      say('Could not create the program: ' + err.message);
    }
  }

  function doDeleteProgram() {
    var d = sel.disk, e = entryAt(sel.disk, sel.entry.slot);
    if (!e || e.type !== 'P') return;

    var kgs = d.keygroups(e);
    var used = {};
    kgs.forEach(function (kg) {
      [kg.zone1, kg.zone2].forEach(function (z) { if (z.inUse) used[z.name.trim()] = true; });
    });
    var names = Object.keys(used);

    // The samples outlive the program; say so, because "delete program" reads like it
    // might take them with it.
    var msg = 'Delete program ' + e.name.trim() + '?\n\n' +
      kgs.length + ' keygroup' + (kgs.length === 1 ? '' : 's') + ', ' +
      fmt(e.length) + ' bytes, ' + e.chainBlocks +
      ' block' + (e.chainBlocks === 1 ? '' : 's') + ' returned to the disk.\n\n' +
      (names.length
        ? 'The ' + names.length + ' sample' + (names.length === 1 ? '' : 's') +
          ' it plays stay on the disk:\n    ' +
          names.slice(0, 8).join(', ') + (names.length > 8 ? ', ...' : '') + '\n\n'
        : 'It plays no samples.\n\n') +
      'This cannot be undone except with Undo.';

    if (!confirm(msg)) return;

    try {
      pushUndo(d, 'delete program ' + e.name);
      var r = d.deleteProgram(e);

      sel = { disk: d, entry: null };
      buildTree();
      showDisk(d);
      say('Deleted program ' + e.name.trim() + '  -  ' + r.blocksFreed +
          ' blocks freed.  Unsaved changes.');
    } catch (err) {
      say('Could not delete: ' + err.message);
    }
  }

  $('opTrim').onclick = doTrim;
  $('opHalve').onclick = doHalve;
  $('opStretch').onclick = doStretch;
  $('opSlice').onclick = doSlice;
  $('opLoop').onclick = doFindLoop;

  /*
   * Save the selected sample as a WAV.
   *
   * The disk download beside this one writes the image as an S950 would read it, which is
   * the right thing for putting back on a floppy and no use at all in a DAW. This is the
   * other half: the audio, at its own rate, with the loop described in the file rather
   * than baked into it. See Disk.prototype.sampleWav.
   */
  $('opExportWav').onclick = function () {
    if (!sel || !sel.entry || sel.entry.type !== 'S') return;

    var e = sel.entry;
    var bytes;

    try { bytes = sel.disk.sampleWav(e); }
    catch (err) { say('Could not build the WAV: ' + err.message); return; }

    // A header and nothing after it means the sample had no audio on the disk.
    if (!bytes || bytes.length <= 44) { say('That sample has no audio on the disk.'); return; }

    var file = (e.name.trim().replace(/[^A-Za-z0-9 ._-]+/g, '_') || 'sample') + '.wav';

    var blob = new Blob([bytes], { type: 'audio/wav' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);

    var loops = (e.loopMode === 'L' || e.loopMode === 'A') && e.loopLength >= 2;
    say('Wrote ' + file + '  (' + fmt6(bytes.length) + ' bytes, ' + e.sampleRate + ' Hz'
        + (loops ? ', loop written into the file' : ', one-shot') + ')');
  };

  // ------------------------------------------------------------- find a loop
  //
  // The machine loops end-length .. end, so the search is for the length. What the
  // dialog adds to it is the two things a person knows and the finder cannot: how
  // short a loop is still musical, and whether the loop should run to the end of the
  // sample or to the end marker the sample already carries.

  var loopState = null;

  function doFindLoop() {
    if (!sel || !sel.entry || sel.entry.type !== 'S') return;
    var d = sel.disk, e = sel.entry;
    var words = d.sampleWords12(e);
    if (words.length < 512) { say(e.name.trim() + ' is too short to loop.'); return; }

    loopState = { disk: d, entry: e, words: words, found: null, picked: -1 };
    $('lpSource').textContent = e.name.trim() + '  -  ' + fmt(e.sampleCount) + ' words at ' +
      fmt(e.sampleRate) + ' Hz, ' + (e.sampleCount / e.sampleRate).toFixed(2) + 's';

    // Where the note stops being held. A sample with a release wants its loop to end
    // before the tail, and the library is full of them - looping to the end of the
    // sample would play the release round and round and leave none of it to hear.
    loopState.sustain = AkaiAudio.sustainEnd(words, e.sampleRate);

    var hasEnd = e.loopEnd > 0 && e.loopEnd < e.sampleCount;

    // Worth starting from only when the note is held and then released. On a
    // plucked or struck sample the level falls from the attack onwards, so the
    // sustain "ends" almost immediately and there would be nothing left to loop:
    // that wants the whole sample, and the end moved by hand if at all.
    var hasTail = words.length - loopState.sustain > e.sampleRate * 0.05;
    var roomToLoop = loopState.sustain > words.length * 0.4;
    $('lpEnd').options[2].disabled = !hasEnd;
    $('lpEnd').value = hasEnd ? 'current'
                    : (hasTail && roomToLoop) ? 'sustain' : 'sample';
    $('lpMode').value = e.loopMode === 'A' ? 'A' : 'L';

    $('loopDlg').showModal();
    refreshLoop();
  }

  /** The loop end the dialog is working to: whatever was clicked, else the choice. */
  function loopEndNow() {
    var e = loopState.entry, words = loopState.words;
    if (loopState.picked > 0) return loopState.picked;
    var how = $('lpEnd').value;
    if (how === 'current' && e.loopEnd > 0) return Math.min(e.loopEnd, words.length);
    if (how === 'sustain') return loopState.sustain;
    return words.length;
  }

  function refreshLoop() {
    if (!loopState) return;
    var e = loopState.entry, words = loopState.words;
    var end = clamp(loopEndNow(), 2, words.length);
    end -= end % 2;

    var ms = clamp(parseInt($('lpMin').value, 10) || 40, 2, 5000);
    var minLength = Math.max(64, Math.round(e.sampleRate * ms / 1000));

    var got = AkaiAudio.findLoop(words, { end: end, minLength: minLength });
    loopState.found = got;
    loopState.end = end;

    $('lpEndAt').textContent = 'word ' + fmt(end) + '  (' +
      (end / e.sampleRate).toFixed(3) + ' s' +
      (words.length - end > 1 ? ', leaving ' +
        ((words.length - end) / e.sampleRate).toFixed(3) + ' s of tail' : ', the whole sample') + ')';

    drawLoopPreview();

    var box = $('lpSummary');
    if (!got) {
      box.textContent = 'No loop fits before ' + fmt(loopState.end) + ': the shortest loop' +
        ' asked for is longer than the part being searched. Ask for a shorter one, or' +
        ' click further along the waveform.';
      box.classList.add('bad');
      $('lpGo').disabled = true;
      $('lpPreview').disabled = true;
      return;
    }

    var secs = got.length / e.sampleRate;
    // The match is the correlation of the two windows either side of the join. Where
    // it lands says more than the number does, so the summary says which it is.
    var verdict = got.match >= 0.95 ? 'The join should be inaudible.'
      : got.match >= 0.8 ? 'The join should be close, and may tick on a quiet passage.'
      : got.match >= 0.5 ? 'The best on offer, but expect to hear it: try a shorter' +
                           ' minimum, or a sample with a steadier tail.'
      : 'Nothing here loops cleanly - noise and applause have no repeating part to find. It will click.';

    box.textContent = 'Loop ' + fmt(got.from) + ' - ' + fmt(got.end) + '  (' +
      fmt(got.length) + ' words, ' + secs.toFixed(3) + ' s)   ·   match ' +
      got.match.toFixed(3) + '\n' + verdict;
    box.classList.toggle('bad', got.match < 0.5);
    $('lpGo').disabled = false;
    $('lpPreview').disabled = false;
  }

  /** The whole sample, with the loop shaded and its two edges marked. */
  function drawLoopPreview() {
    var c = $('lpWave');
    var s = sizeCanvas(c), g = s.g, w = s.w, h = s.h;
    var words = loopState.words, got = loopState.found;

    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);

    var xOf = function (i) { return Math.round(i * w / words.length); };

    if (got) {
      g.fillStyle = '#e8f1fb';
      g.fillRect(xOf(got.from), 0, Math.max(1, xOf(got.end) - xOf(got.from)), h);
    }

    var step = Math.max(1, Math.floor(words.length / w));
    var mid = h / 2;
    g.strokeStyle = '#3e76b8';
    g.beginPath();
    for (var x = 0; x < w; x++) {
      var at = Math.floor(x * words.length / w), lo = 0, hi = 0;
      for (var i = 0; i < step && at + i < words.length; i++) {
        var v = words[at + i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      g.moveTo(x + 0.5, mid - hi / 2048 * mid);
      g.lineTo(x + 0.5, mid - lo / 2048 * mid);
    }
    g.stroke();

    if (!got) return;
    [[got.from, '#208c48'], [got.end, '#be4628']].forEach(function (m) {
      g.strokeStyle = m[1];
      g.beginPath();
      g.moveTo(xOf(m[0]) + 0.5, 0);
      g.lineTo(xOf(m[0]) + 0.5, h);
      g.stroke();
    });
  }

  ['lpMin', 'lpMode'].forEach(function (id) {
    var el = $(id);
    if (el) { el.onchange = refreshLoop; }
  });

  // choosing how the end is decided drops whatever was clicked before
  if ($('lpEnd')) $('lpEnd').onchange = function () {
    if (loopState) loopState.picked = -1;
    refreshLoop();
  };

  // Clicking the waveform puts the end where the pointer is. The loop is found
  // backwards from there, so this is how a release gets left alone.
  if ($('lpWave')) $('lpWave').onclick = function (ev) {
    if (!loopState) return;
    var box = this.getBoundingClientRect();
    var at = Math.round((ev.clientX - box.left) / box.width * loopState.words.length);
    at -= at % 2;
    loopState.picked = clamp(at, 64, loopState.words.length);
    refreshLoop();
  };

  if ($('lpPreview')) $('lpPreview').onclick = function () {
    if (!loopState || !loopState.found) return;
    var got = loopState.found;
    play(loopState.disk, loopState.entry, 0, true, null, null,
         { from: got.from, end: got.end });
  };

  if ($('lpCancel')) $('lpCancel').onclick = function () {
    stop();
    $('loopDlg').close();
    loopState = null;
  };

  if ($('lpGo')) $('lpGo').onclick = function () {
    if (!loopState || !loopState.found) return;
    var d = loopState.disk, e = loopState.entry, got = loopState.found;
    var mode = $('lpMode').value;

    stop();
    pushUndo(d, 'loop on ' + e.name.trim());
    try {
      d.setLoop(e, got.end, got.length, mode);
      $('loopDlg').close();
      buildTree();
      reselect(d, e.slot, 'Looped ' + e.name.trim() + ' over the last ' + fmt(got.length) +
        ' words (' + (got.length / e.sampleRate).toFixed(3) + ' s), match ' +
        got.match.toFixed(3) + '.  Unsaved changes.');
    } catch (err) {
      say('Could not set that loop: ' + err.message);
    }
    loopState = null;
  };

  // ------------------------------------------------------------------- slicing
  //
  // Cutting a break into one-shots. The detector is cheap enough to rerun on every
  // twitch of the slider, so the markers and the cost are always live - and the cost
  // matters, because slicing is the one operation that can run out of directory slots,
  // disk blocks or sampler memory, and the sampler's memory is not something the disk
  // can tell us.

  var sliceState = null;

  function sliceRamChoice() {
    var stored = null;
    try { stored = localStorage.getItem('akai.samplerRam'); } catch (e) { stored = null; }
    return stored || '2359296';
  }

  function drawSliceWave(words, cuts) {
    var c = $('slWave');
    var w = Math.max(200, c.clientWidth || 560), h = c.clientHeight || 120;
    var dpr = window.devicePixelRatio || 1;

    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);

    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var mid = h / 2, step = Math.max(1, Math.floor(words.length / w));
    g.strokeStyle = getComputedStyle(c).color;
    g.globalAlpha = 0.75;
    g.beginPath();

    for (var x = 0; x < w; x++) {
      var from = Math.floor(x * words.length / w), lo = 0, hi = 0;
      for (var i = from; i < from + step && i < words.length; i++) {
        if (words[i] < lo) lo = words[i];
        if (words[i] > hi) hi = words[i];
      }
      g.moveTo(x + 0.5, mid - (hi / 2048) * mid);
      g.lineTo(x + 0.5, mid - (lo / 2048) * mid);
    }
    g.stroke();

    g.globalAlpha = 1;
    g.strokeStyle = '#d9534f';
    g.fillStyle = '#d9534f';
    g.lineWidth = 1;

    cuts.forEach(function (cut, i) {
      var x = Math.round(cut * w / words.length) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
      if (cuts.length <= 32) {
        g.font = '10px system-ui, sans-serif';
        g.fillText(String(i + 1), x + 2, 10);
      }
    });
  }

  function refreshSlice() {
    if (!sliceState) return;

    var d = sliceState.disk, e = sliceState.entry, words = sliceState.words;

    var cuts = AkaiAudio.detectSlices(words, e.sampleRate, {
      sensitivity: parseInt($('slSens').value, 10),
      minSliceMs: clamp(parseInt($('slMin').value, 10) || 40, 5, 1000)
    });

    var program = null;
    if ($('slProg').value !== '') {
      var slot = parseInt($('slProg').value, 10);
      for (var i = 0; i < d.entries.length; i++)
        if (d.entries[i].slot === slot) program = d.entries[i];
    }

    var plan = d.planSlices(e, cuts, {
      program: program,
      maxRam: parseInt($('slRam').value, 10),
      rootKey: parseInt($('slRoot').value, 10)
    });

    sliceState.cuts = cuts;
    sliceState.plan = plan;
    sliceState.program = program;

    $('slSensVal').textContent = $('slSens').value;
    $('slRootName').textContent = Akai.noteName(clamp(parseInt($('slRoot').value, 10) || 60, 0, 127));

    drawSliceWave(words, cuts);

    var note = plan.slices.length + ' slices  -  ' + plan.blocks + ' of ' + d.freeBlocks() +
               ' free blocks, ' + plan.slots + ' of ' + d.freeSlots() + ' free slots, ' +
               Math.round(plan.ram / 1024) + ' KB of ' + Math.round(plan.spare / 1024) +
               ' KB free sampler memory';

    if (program)
      note += '  -  keys ' + Akai.noteName(clamp(parseInt($('slRoot').value, 10), 0, 127)) +
              ' upward in ' + program.name.trim();

    $('slSummary').textContent = plan.ok ? note : plan.problems.join('  ');
    $('slSummary').classList.toggle('bad', !plan.ok);
    $('slGo').disabled = !plan.ok;
  }

  function doSlice() {
    var d = sel.disk, e = entryAt(sel.disk, sel.entry.slot);
    if (!e || e.type !== 'S') return;

    var words = d.sampleWords12(e);
    if (!words.length) { say(e.name + ' has no audio to slice.'); return; }

    sliceState = { disk: d, entry: e, words: words };

    $('slSource').textContent = e.name.trim() + '  -  ' + fmt(e.sampleCount) + ' words at ' +
      fmt(e.sampleRate) + ' Hz, ' + (e.sampleCount / e.sampleRate).toFixed(2) + 's';

    var pick = $('slProg');
    pick.textContent = '';
    pick.appendChild(new Option('none - just make the samples', ''));
    d.programsInOrder().forEach(function (p) {
      pick.appendChild(new Option(p.name.trim() + '  (' + d.keygroupCount(p) + ' keygroups)', p.slot));
    });
    if (pick.options.length > 1) pick.selectedIndex = 1;

    $('slRam').value = sliceRamChoice();
    $('sliceDlg').showModal();
    refreshSlice();
  }

  ['slSens', 'slMin', 'slProg', 'slRoot', 'slRam'].forEach(function (id) {
    var el = $(id);
    if (el) { el.oninput = refreshSlice; el.onchange = refreshSlice; }
  });

  if ($('slRam')) $('slRam').addEventListener('change', function () {
    try { localStorage.setItem('akai.samplerRam', $('slRam').value); } catch (e) { /* private window */ }
  });

  if ($('slCancel')) $('slCancel').onclick = function () {
    $('sliceDlg').close();
    sliceState = null;
  };

  if ($('slGo')) $('slGo').onclick = function () {
    if (!sliceState || !sliceState.plan || !sliceState.plan.ok) return;

    var d = sliceState.disk, e = sliceState.entry;
    var root = clamp(parseInt($('slRoot').value, 10) || 60, 0, 127);

    pushUndo(d, 'slice ' + e.name);
    try {
      var r = d.sliceSample(e, sliceState.cuts, {
        program: sliceState.program,
        rootKey: root,
        maxRam: parseInt($('slRam').value, 10)
      });

      $('sliceDlg').close();
      buildTree();
      reselect(d, e.slot, 'Sliced ' + e.name.trim() + ' into ' + r.added.length + ' samples' +
        (r.keygroups ? ', mapped to ' + r.keygroups + ' keygroups from ' + Akai.noteName(root) : '') +
        '.  Unsaved changes.');
    } catch (err) {
      say('Could not slice: ' + err.message);
    }
    sliceState = null;
  };


  wireEnv('vca');
  wireEnv('vcf');

  window.addEventListener('resize', function () {
    waveWidth = -1;
    if (!$('waveWrap').hidden) drawWave();
    if (!$('kgWrap').hidden) drawPiano();
    if (!$('kgEdit').hidden) { drawEnv('vca'); drawEnv('vcf'); }
  });

  var depth = 0;
  window.addEventListener('dragenter', function (e) {
    e.preventDefault();
    if (++depth === 1) $('drop').classList.add('on');
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function () {
    if (--depth <= 0) { depth = 0; $('drop').classList.remove('on'); }
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    depth = 0;
    $('drop').classList.remove('on');
    if (e.dataTransfer && e.dataTransfer.files) openFiles(e.dataTransfer.files);
  });

  $('addSampleBtn').style.display = 'none';
})();












// The build of akai.js actually running, so a stale cached copy shows up here.
(function () {
  var el = document.getElementById('buildStamp');
  if (el) el.textContent = Akai.BUILD || '?';
}());
