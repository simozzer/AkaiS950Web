# Akai S950 Studio — web version

A browser tool for Akai S900/S950 floppy images. Reads Gotek/HxC `.hfe` and raw 800K `.img`
sector images: the MFM bitstream, the directory and allocation table, sample headers,
programs and keygroups. Browse a disk, hear it, edit it, and write a new image you can copy
straight back to your USB stick.

Plain HTML and JavaScript — no build step, no dependencies, and it runs from a `file://`
page. Everything happens in the browser; nothing is uploaded anywhere.

![A program open, on its first keygroup](docs/images/overview.png)

The keyboard across the top shows every keygroup's range and plays any key at its own
pitch. The numbers down the left are the keygroups; everything about the selected one is in
the editor beside them, and the waveform is docked along the bottom.

**New here? [Start with the tutorial](docs/tutorial.md)** — open a disk, change something,
and write it back.

## Running it

Open `index.html`. That is all — it is deliberately written as plain scripts rather than ES
modules so it works straight from `file://` with no server and no build step.

Then drop `.hfe` or `.img` files anywhere on the page, or use **Open images**.

### Serving it

Two things a `file://` page cannot have, because browsers only grant them over http or
https: **Web MIDI**, so the MIDI input control stays greyed out, and `fetch`, which
`test/selftest.html` needs to load a disk image. For either, serve the folder — any static
server will do:

```
node serve.js               http://localhost:8080/   (included; takes a port: node serve.js 8099)
python -m http.server 8000  http://localhost:8000/   (python3 on a Mac or Linux)
npx serve                   prints its own address
```

Then open the address it prints rather than the file. The self-test wants a disk to work
on, named in the query string:

```
http://localhost:8080/test/selftest.html?disk=DSKA0000-bench.hfe
```

## Layout

The app fills the window: the tree down the left, the detail pane in the middle, and the
**waveform docked along the bottom** so it stays visible while you work, with its
transport — play, stop, and the two playback options — in a column beside the canvas
rather than in a row beneath it, since the dock is the shortest thing on screen and the
height is worth more to the waveform. Only the middle scrolls — the page itself does not.

Directly under the toolbar is a one-line **info strip** carrying the selected file's name,
its actions, its own editable fields and a summary of the read-only facts. A program says
everything it needs to there — MIDI program, key to loudness, crossfade, keygroup count,
size, load address and which machine wrote it — leaving the whole pane below for the
keyboard, the keygroup list and the editor.

Below the keyboard the pane splits: a narrow **list of keygroup numbers** on the left, and
the **editor** filling the rest. The list carries only the number because every other column
it once had was a read-only copy of a field in the editor beside it; hovering a number still
names its key range and sample, and a keygroup whose sample is not on this disk stays marked.
It sticks to the top as the editor scrolls.

The editor itself is three columns. The **envelopes** are on the left, with the **key range
and velocity** directly under them — the things that decide when a voice sounds and how
hard, which is what the envelopes are answering — and the **LFO** beside those, still
under the envelopes it modulates. **Both zones and the flags** make the third column.

## What it does

- Decodes HFE images and lists their contents by type
- Full field detail for samples, programs and keygroups
- Waveform with the start, loop and end markers, and the loop region shaded
- Piano keyboard showing every keygroup's range, the selected one highlighted
- Hovering a key names it and gives its MIDI number
- Clicking a key plays the keygroup's sample **at that key's pitch**, using the same
  varispeed the sampler does
- Honours loop points on playback — a looping sample sustains rather than stopping,
  which the WinForms version cannot do
- Adds samples from any audio file the browser can decode, converted to Akai 12-bit
- Slices a break into one-shots on detected onsets, mapping them to consecutive keys
- **New image** starts an empty 800K disk, to fill and download
- Creates and deletes programs, adds and removes keygroups, renames and deletes samples
- Stretches a sample to a new tempo, halves its rate, trims the silence off both ends
- Finds a loop in a sustained sample, and says how clean the join is
- Rebuilds and downloads the image as `.hfe` or as a raw `.img`, for FlashFloppy

The drum set and overall-settings files are kept on the disk but not shown. Nothing in
either is decoded: the four disks whose drum set is marked in use carry one factory
default, byte for byte identical on a disk with five samples and one with twenty-six, so
there is nothing to display but undecoded hex.

## Some of it in use

| | |
|---|---|
| **Several keygroups at once.** Ctrl and shift pick them; every control then writes to all of them, under one undo. | ![](docs/images/multi-select.png) |
| **A key range, by pointing at it.** Click the low key, then the high one. The same key twice gives a one-key group. | ![](docs/images/key-range.png) |

| | |
|---|---|
| ![](docs/images/find-loop.png) | ![](docs/images/slice.png) |
| **Finding a loop.** It reports how clean the join is and says what to expect of it. The loop end is a choice — a held note has a release after its loop. | **Slicing a break.** Cut points move with the sensitivity, and the cost in slots, blocks and sampler memory is shown before you commit. |

The screenshots are generated, not posed: `node docs/shots.js` drives a real browser over
the DevTools protocol and writes `docs/images`, so they can be taken again whenever the
interface moves.

## Checking it against the original

The format code in `akai.js` is a direct port of the C# in `..\AkaiS950List`, and is held to
the same standard: it is checked against the same corpus of disk images.

```
powershell -File tools/make-expected.ps1 E:\     # what the C# sees, as JSON
node test/verify.js E:\                         # what the JavaScript sees, diffed against it
```

Three things are proved:

1. every image decodes with no bad CRCs and no missing sectors;
2. re-encoding every sector with its own data reproduces the original HFE **byte for byte** —
   the identity round-trip that validates the MFM writer;
3. the decoded contents match the C# manifest file by file and sample by sample, including a
   checksum of every sample's decoded audio.

Last run:

```
disks decoded        : 102
files                : 1712
samples              : 1120
bad-CRC sectors      : 0
missing sectors      : 0
identity round-trips : 102 checked, 0 differing
mismatches vs C#     : 0
elapsed              : 13.7 s
```

### The UI has its own test

`test/selftest.html` drives the real interface the way a person would — it drops a disk image on
the page, clicks through the tree, and checks that the panes actually filled in and the
canvases actually drew. It also runs the identity round-trip a second time, in the browser.

```
node serve.js 8099
# then open http://localhost:8099/test/selftest.html?disk=test.hfe
```

with a disk image copied into this folder as `test.hfe`. It reports PASS or FAIL in the page
title, so it can be run headless:

```
msedge --headless --dump-dom "http://localhost:8099/test/selftest.html?disk=test.hfe"
```

## Containers

Both are read; both can be written.

- **HFE** — the Gotek/HxC container. Written by patching the sectors of the HFE the disk
  was opened from, in place: every Akai sector is 1024 bytes, so nothing moves and the MFM
  bitstream, gaps and sync marks around it are left exactly as they were.
- **IMG** — the bare 800K sector image: 80 cylinders x 2 sides x 5 sectors x 1024 bytes,
  819,200 bytes. This is what `Disk.image` already holds, so writing it is a copy and
  converting an HFE to it is lossless — `test/imgtest.js` checks that byte for byte, audio
  included, on the whole corpus.

`.img` to `.hfe` works too: with no bitstream to patch, the container is built from
scratch — header, track list, and for every one of the 160 track/sides the gaps, sync
fields, index and address marks, CRCs and clock bits.

The layout was not assumed from the IBM System 34 spec but measured from the library,
where all 101 disks agree exactly: one identical 512-byte header, 25000 bytes per track,
sectors 1..5 with no skew, the first ID address mark at bit 4928 of every side, and the
gap fill running on through the 44 bytes of padding at the end of each side's last
256-byte chunk. Because of that, the encoder is held to reproduction rather than mere
validity: `test/imgtest.js` rebuilds every disk from its sectors alone and requires the result
to match the original file **byte for byte**. All 101 do.

## Files

The root holds the app and nothing else: open `index.html` and that is the whole of it.
Everything that checks the app, or was used to work the format out, lives beside it.

| | |
|---|---|
| `index.html`, `style.css` | the page |
| `app.js` | the interface: tree, canvases, editors, Web Audio |
| `akai.js` | the format: HFE, MFM decode and encode, filesystem, samples, programs. No DOM, no Node — the same file runs in both |
| `audio.js` | decoding, rate conversion, 12-bit quantising, WSOLA time stretch, the loop finder |
| `serve.js` | static server, for testing or hosting |

### `test/` — what checks it

| | |
|---|---|
| `selftest.html` | end-to-end test of the interface, in a browser |
| `fsck.js` | structural checker for one image: CRCs, chains, the arena, program headers, zone pointers |
| `verify.js` | checks the port against the corpus, the way the C# tool sees it |
| `arenatest.js` | churns keygroups across the corpus, checking the arena never drifts |
| `deltest.js` | deletes a sample from every image and checks what is left |
| `progtest.js` | creates and deletes a program on every image, and checks the round trip |
| `slicetest.js` | slices a break on every image with room for it |
| `imgtest.js` | converts every image to raw `.img` and checks nothing is lost |
| `looptest.js` | the loop finder, against the loops the library shipped with |
| `trimtest.js` | trimming both ends, and that a loop is never cut into |
| `newdisk.js` | builds a disk from nothing, fills it and writes it both ways — the one test that needs no images |
| `vcftest.js` | measures the VCF — flat passband, −3 dB at cutoff, 36 dB/octave — and checks the calibrator recovers a mapping it is not given |
| `keycaltest.js` | checks the key-tracking calibrator recovers a fraction it is not told |
| `miditest.js` | reads the calibration MIDI file back and checks it matches the plan |
| `lfotest.js` | builds an S950 whose LFO behaves in a way chosen in advance, plays the whole run through it and checks the analysis finds that behaviour without being told it |

### `tools/` — what made it

| | |
|---|---|
| `benchplan.js` | the calibration run, described once, so the disk, the MIDI file and the analysis agree |
| `benchdisk.js` | checks — or rebuilds — the `CALIB` programme against that plan |
| `makemidi.js` | writes the run as a Standard MIDI File |
| `benchcal.js` | reads one take of the run and settles everything it can |
| `emulate.js` | renders the run through the emulation, as a WAV |
| `vcfcal.js` | derives the real cutoff mapping from recordings of the hardware |
| `keycal.js` | what key-to-filter tracking means, measured from three notes |
| `lfoplan.js` | the LFO calibration run, described once |
| `lfodisk.js` | builds the `LFOCAL` disk from nothing: three generated tones and 28 keygroups |
| `lfomidi.js` | writes that run as a Standard MIDI File |
| `lfocal.js` | demodulates a take of it and reports what the LFO actually does |
| `probe.js`, `ram.js`, `zones.js`, `repair.js` | one-off diagnostics from working the format out |
| `makezip.js` | builds the downloadable bundle — the page and what it loads, read out of `index.html` rather than listed by hand |
| `make-expected.ps1` | dumps what the C# sees, for `test/verify.js` to diff against |

### `docs/` — what explains it

| | |
|---|---|
| `tutorial.md` | the walkthrough: open a disk, change something, write it back |
| `S950-Disk-Format.pdf` | how the format works, in sixteen pages |
| `S950-Disk-Format.html` | the source it is printed from |
| `format-check.js` | re-counts every figure in that document against the library |
| `shots.js` | regenerates the screenshots by driving a real browser |

## Starting a disk from nothing

**New image** makes an empty 800K disk in the page. Fill it like any other and press
**Download image**.

An empty disk really is 800 blocks of zeros. The only structures in the reserved blocks
are the directory and the allocation table, and both are empty when zero: across all 101
library disks the 960 bytes after the table are zero, so there is no boot record, label or
signature to reproduce.

What it does not write are the `OVERALL SE` and `DRUM SET` files that 99 of the 101 carry.
Those hold settings rather than structure — and the overall file opens with a sample name,
which a disk with no samples cannot honour. Two library disks have neither and read
perfectly, which is the evidence that their absence is allowed; the sampler writes its own
when you save settings on it.

`test/newdisk.js` builds one, fills it, writes it as both containers and reads each back,
checking the directory has no holes, the zone pointer is the sample position, the program
header restates its own layout, and the audio survives the round trip byte for byte.

**What is not proven:** a disk made this way has never been put in front of a real S950.
Everything it contains follows rules confirmed on hardware, and `fsck.js` finds nothing
wrong with it, but that is not the same as a machine loading it. Try one before you rely
on it.

## Editing

Select a program, then a keygroup number from the list on the left, and the editor fills
the space beside it. The first keygroup is selected for you.

**Several keygroups can be selected at once** — ctrl-click adds one and takes it out
again, shift-click takes the run from the last one clicked, exactly as a file list does.
The editor then shows the **lead**, the one clicked last, marked in the list with a bar
and in bold while the rest of the selection is tinted; the keyboard shades them all and
says how many are selected.

Every control in the editor then writes to all of them: a slider, an envelope corner,
the VCF amount, a flag, a zone's sample, and the key range taken from the keyboard. It
is one undo however many it touched, and the status line and the undo entry both name
the count — *To loudness on 4 keygroups* — so a change made to more than you meant is
obvious and one keystroke from gone. **Delete** takes the whole selection, and the
editor shows what it is editing at the top: *8 of 10 · editing 5 selected*.

What the editor holds:

- **Both envelopes**, VCA and VCF, dragged by their corners — the peak sets attack, the
  corner sets decay and sustain together, the last sets release. The VCF amount is a vertical
  slider beside its envelope.
- **Parameter sliders** for the velocity switch and sensitivities, LFO, zone tuning and
  the flags, each with its exact value beside it. They are things you sweep by ear rather
  than numbers you arrive knowing, so a slider writes as it moves: you hear the change on
  the next note, the whole drag counts as one undo, and the editor is only rebuilt when
  the handle is let go. The key range has no control of its own here: it is set on the
  keyboard, and the keyboard's caption gives the selected keygroup's range in both MIDI
  numbers and note names.
- **From keyboard**, beside the Key range heading, sets the range by pointing at it rather
  than by typing two MIDI numbers: the next click on the keyboard is the low key and the
  one after it the high, with the keys shaded as you move between them. The same key twice
  gives a one-key group, the two clicks can come in either order, and Esc cancels. Both
  keys go in under a single undo.
- **Add keygroup** copies the selected one so it arrives playable; **Delete keygroup** removes
  it. Both resize the program file, relink the keygroup chain and shift the RAM arena, exactly
  as the WinForms version does.

### Finding a loop

The S950 holds a loop as an **end point and a length**, and plays `end - length .. end`
round and round. The library bears that out: of its 324 looped samples the loop *start*
field is simply 0 in 250 of them, and the length is what says where the loop begins. So
the only thing to find is how far back it restarts.

**Find loop**, on a sample, looks for it. The join the ear hears is the one from the loop
end back to that point, so what it looks for is the point whose approach matches the
approach to the end — a normalised cross-correlation, coarse over a properly decimated
copy and then exact around the best few candidates, kept apart so a short clean loop
cannot hide under a long mediocre one.

### The loop end is a choice

A loop does not have to run to the end of the sample, and assuming it did was wrong.
`BOWEDBASS` on disk 51 is the case that shows it: every one of its nine samples loops
**before** the end, leaving between 0.12 and 0.48 s of tail — the release you hear when
the key comes up. Loop to the end of the sample and that release is played round and
round, and there is none of it left to hear.

So the end is offered three ways — **where the sustain ends**, **the end of the sample**,
and **the end marker it has now** — and the waveform is clickable: put the end where you
want it and the loop is found backwards from there.

The sustain end is a starting point, and honestly only that. It is the last frame of a
short-time RMS envelope within 2 dB of the loudest, which finds the knee where a held
note starts to let go. Of the library's 324 looped samples only 30 stop short by more
than 50 ms, and on those this lands about **200 ms later** than the person did, at every
threshold tried: they left a margin so the loop would not eat into the release. That is a
musical judgement, not an acoustic edge, so the tool marks the knee and leaves the
judgement to whoever is listening. It is not offered at all on a sample whose level falls
from the attack onwards — a plucked or struck note has no sustain to end, and taking the
knee there would leave nothing to loop.

The other thing the finder cannot know is asked for too: how short a loop is still
musical.

It reports the **match**, −1 to 1, and says plainly what to expect of it: inaudible above
0.95, audible below about 0.8, and hopeless on material with no repeating part in it —
applause and running water have no clean loop, and the number says so rather than
pretending. **Preview** auditions the loop before it is written.

`test/looptest.js` measures it against the loops somebody chose by ear on the machine, using
the same join measure for both. Across the library it averages **0.881 where the shipped
loops average 0.793** — better on 110 samples, as good on 158, worse on 30, and those 30
are noise where both answers score near zero.

```
node test/looptest.js <directory of .hfe> [modes]
```

A note on the loop mode, which the tool now changes properly: how many 10-byte
descriptors a sample takes in the table after the keygroup arena depends on it — a
looping sample takes one more than a one-shot — so changing the mode moves the descriptor
pointer of every sample after it. Writing the byte alone, which is what this did before,
broke that chain on 95 of the 96 library disks it was tried on. `test/fsck.js` checks the chain
now, and `looptest.js modes` flips a mode on every disk and confirms it holds.

**Add sample** reads an audio file and writes it into the selected disk. The browser decodes
it — WAV, MP3, FLAC, AAC, Ogg, whatever it supports, which is more than the desktop version
manages without ffmpeg — and an `OfflineAudioContext` does the mixdown to mono and the rate
conversion. It is normalised, quantised to 12 bits, and refused outright if it will not fit
in the free blocks.

Edits change the image held in the page. **Download image** asks what to call the file and
writes it out; nothing is altered in place.

The extension follows the image rather than what you type: an HFE saves as `.hfe` and a raw
sector image as `.img`, whether you typed the right one, the wrong one or none at all.
Characters a filename cannot hold are replaced, and leaving the box empty keeps the suggested
name.

**Sample operations**, on the waveform pane: **Trim silence**, **Halve rate**, **Fit to tempo**
(WSOLA time stretch, pitch preserved), **Find loop**, and **Rename** on the file heading —
which retargets every keygroup zone that named the sample.

### Trimming silence

It takes the silence off **both ends**, and moves the markers with the audio. Silence means
below 8 of the 12-bit range — about −48 dB — so a tail that fades into noise rather than to
nothing is left alone, on the grounds that a fade is audio and the tool should not guess
otherwise.

The end is the delicate one, because the tail of a sample is where a loop lives. A cut that
reached into a loop would leave the sampler looping over audio that is no longer there, so
the cut **stops at the loop end** and the confirmation says when it did.

Shortening a file also moves what comes after it. Samples sit back to back in the sampler’s
RAM in directory order, and their loop descriptors sit in one table the same way, so a trim
moves every sample after the one trimmed. The **zone pointers do not move**: those encode a
sample’s position in directory order, and a trim changes no order at all.

`test/trimtest.js` checks all of it — first on made-up samples where the answer is known to
the word, then by trimming for real across the library. 81 of the 101 disks have something
to trim, 67 of those move the samples that follow them in RAM, and all 81 come through with
the RAM chain, the descriptor chain, the directory and every zone pointer intact, saved and
reloaded.

It compares before with after rather than asking whether a disk is perfect: seven of the
disks it touches already have a loop descriptor pointer that does not follow the one before
it, and a test that ignored that would blame the trim for them.

**Programs** get their own panel: MIDI program, key to loudness, positional crossfade, and
rename.

### Deleting a sample

**Delete** on a sample's info strip, behind a confirmation that names every keygroup zone
that will be emptied. Three things move together, or the disk is left inconsistent:

- zones naming the sample are cleared to the unused placeholder;
- zones naming a **later** sample have their pointer pulled back one record — those pointers
  are a sample's position in directory order, and every later sample has just moved down one;
- later samples shift down in sample RAM by the space this one occupied.

Then its blocks return to the free pool and its directory slot is cleared.

`test/deltest.js` checks this against the whole corpus: it deletes a sample from the middle of
every image and verifies the disk afterwards — every other file byte-identical and still
readable, the free count exactly right, the RAM chain unbroken, no zone left naming a missing
sample, and the result surviving a save and reload.

```
disks tested       : 97
samples deleted    : 97
zones emptied      : 166
pointers adjusted  : 788
blocks recovered   : 5543
problems           : 0
```

### Undo

**Undo** and **Redo** in the toolbar, or Ctrl+Z and Ctrl+Y, keeping 24 steps. A step is a whole
disk image — 800 KB each, so 24 is about 19 MB, cheap enough not to think about and exact
whatever the edit touched, including the ones that resize a file and move things in RAM.

Dragging an envelope corner is one step, not one per mouse move.

## Calibrating the filter and the envelopes

The filter and envelope model is measured against the machine rather than guessed at.
Everything the measurement needs is generated from one file, `tools/benchplan.js`, so the disk,
the MIDI file and the analysis cannot drift apart - which matters, because the analysis
identifies each clip by its position in the run and nothing else. A keygroup set to the
wrong filter is not an error; it is a wrong answer delivered confidently.

Every test is a keygroup of one programme, `CALIB`, on its own key. The obvious
arrangement - one programme per test, selected by program change - does not survive
Ableton Live, which treats program change as a per-track I/O setting rather than clip
data, so an imported file arrives as bare notes and silently tests one programme
twenty-two times. Changing test therefore means playing a different note, which every
sequencer can do.

All the measurements divide by `NOISE`, a sample this project generates and which sits
bit-exact in the disk image. The source spectrum, the level of each clip and anything the
recording chain added all cancel, leaving only the sampler's own shaping.

```
node tools/benchdisk.js check DSKA0000-bench.hfe   # the disk matches the plan
node tools/makemidi.js                            # writes tools/AkaiCalibration.mid
node test/miditest.js                             # the MIDI file matches the plan
```

`benchdisk.js build <in> <out>` writes the programme the plan describes, if the two ever
part company.

### Recording the sampler

Load the disk, select `CALIB`, point a sequencer at the S950 on MIDI channel 1, record
the audio output and play `AkaiCalibration.mid`. It runs for 109 seconds. Then:

```
node tools/benchcal.js take.wav
```

which reports every constant the take settles, and says so plainly where a measurement
is against a stop and means nothing.

### Rendering the emulation

The same run, through the model instead of the machine. `tools/emulate.js` renders it offline
to a 32-bit float WAV - nothing quantised and nothing clipped, however loud the run is,
since the measurements are all ratios and a clipped take would be measuring its own
clipping.

```
node tools/emulate.js emulated.wav
node tools/benchcal.js emulated.wav
```

Run the two reports side by side and hardware and emulation differ only where the model
is wrong. It caught a real error in the cutoff curve.

What it does not check is the playback path. `tools/emulate.js` re-implements the envelope in
a loop of its own, so it settles the model's constants and not the thing you actually
hear - Web Audio's scheduling, the voice handling, the release. The page used to carry a
**Record** button for exactly that, capturing what it played over a MIDI loopback for
`tools/benchcal.js` to read; it was removed once the model stopped moving. Recording the page
through the operating system, or restoring the button from the history, is the way back
to that check if the playback path ever comes under suspicion again.

## Calibrating the LFO

A keygroup stores an LFO as three numbers — delay (byte 15), rate (16) and depth (17) —
plus a desync flag and two bytes saying how far the modwheel and aftertouch may add to
the depth. Every one of them is 0..99, and none of them is in any unit at all.

**The emulation has no LFO yet**, and it is not getting one from guesses. This is the
same shape of apparatus as the filter run — a plan, a disk, a MIDI file, an analysis —
aimed at turning those five bytes into seconds, hertz and cents.

```
node tools/lfodisk.js build                 # writes tools/LFOCAL.img and .hfe
node tools/lfodisk.js check tools/LFOCAL.img
node tools/lfomidi.js                       # writes tools/AkaiLfoCalibration.mid
node test/lfotest.js                        # the whole chain, end to end
```

The disk is built from nothing rather than from a library image, so it carries no audio
but its own and can be rebuilt byte for byte by anyone. It is not in the repo for that
reason. The run lasts four minutes and sixteen seconds.

### What it plays

A steady looped tone, not noise: the filter run measures a spectrum, where noise is
ideal, and an LFO moves pitch, which noise does not have. 250 Hz at 20 kHz makes a
period exactly 80 words and 125 periods exactly 10,000, so the loop is the whole sample
and joins onto itself with no discontinuity at all — a loop that clicked twice a second
would put a spike into the pitch track every time round and be read as modulation.

Three of them, band-limited by construction:

| | |
|---|---|
| `SAW` | 36 harmonics. What the ladders play — strong, evenly spaced partials |
| `SINE` | the fundamental alone, so a wobble in the level is plainly a wobble in the level |
| `PULSE` | a quarter-width rectangle. A different spectrum entirely, played at a setting the sawtooth also plays |

Every keygroup transposes its zone back towards the samples’ root, so whichever key a
test lives on, the note sounds at the same 250 Hz and a take can be checked by ear in
seconds.

### What it asks

Eight rungs of rate, six of depth, five of delay; one slow deep clip held sixteen
seconds to see the waveform; a sine to say whether the LFO moves pitch or level; a pulse
at a depth the sawtooth also plays, as a check that a reading belongs to the machine and
not to the waveform; a wheel climbing through nine steps of one held note; and two pairs
of overlapping voices, with and without desync.

The **desync** pair is the speculative one. The flag is set in 1652 keygroups of 1908, so
whatever it does is the normal case — the guess is that it gives each voice its own LFO
rather than sharing one. Two notes started a second and a half apart say whether their
wobbles line up. They are two octaves apart, which is not a musical choice: the tracker
isolates a tone by averaging over exactly one period of it, and that puts a null on every
multiple of its own frequency, so two octaves up lands the second voice exactly on one.

### How the pitch is read

By spectrum it would be hopeless — a few tens of cents at a few cycles a second, which no
useful window length resolves. So the tone is demodulated, the way an FM receiver does
it: multiply by a cosine and a sine at the tone’s own frequency, average each product
over precisely one period of that tone, and take the angle of the pair. A boxcar average
of length *T* nulls every multiple of *1/T*, so averaging over one period removes every
harmonic exactly — which is why a 36-harmonic sawtooth reads as cleanly as a sine.

Two things in that were wrong at first, and the test caught both:

- **The loudest thing in the clip is not the tone.** Frequency modulation spreads a tone
  into sidebands, and near a modulation index of 2.4 the centre of it vanishes entirely,
  so the peak of the spectrum sat three hertz off and the averaging landed between the
  harmonics instead of on them. The mean of the instantaneous frequency *is* the carrier,
  so it demodulates once to find out where the tone really is and then again there.
- **A depth read as the highest point of the folded cycle is two samples out of
  thousands**, and every smoothing in the chain rounds a corner off them: a triangle at
  12 Hz lost a seventh of its peak that way, which is the difference between a depth law
  that looks linear and one that does not. It is read at the fundamental instead, with
  the tracker’s own response — every boxcar in it, known exactly — divided back out, and
  converted to a peak through whichever waveform the shape section identified.

The rate is looked for in the pitch *and* in the level, because taking it from the pitch
alone would find nothing at all in an LFO that turned out to move the level instead, and
"found nothing" is the wrong answer to that question.

### Recording it

Load `LFOCAL`, select it, point a sequencer at the S950 on MIDI channel 1, record the
audio and play `AkaiLfoCalibration.mid`. Then:

```
node tools/lfocal.js take.wav
```

which prints every reading with how well it was determined beside it, draws the LFO
waveform as it folded, and ends with a block to paste into `audio.js` once there is an
LFO there for it to go in.

### Knowing it works before there is a take

Nobody has recorded one, so `test/lfotest.js` builds an S950 that does not exist: a rate
that doubles every 20 units, a depth of 0.55 cents per unit, a delay of 45 ms per unit
and a triangle. None of those is a guess at what a real S950 does — they are numbers
chosen to be nothing like round and nothing like each other, so a reading that comes out
close cannot be close by luck. The tone is rendered the way the sampler renders it: the
very words `lfodisk.js` writes to the disk, read out of a loop at a rate the LFO moves.

It plays the whole 256-second run through that machine, writes a WAV, and hands `lfocal`
the file and nothing else. It recovers 0.550 cents per unit, doubling every 20.0 units,
0.0450 seconds per unit, and the word *triangle*.

## The format, written down

The format itself is written up in [**S950-Disk-Format.pdf**](docs/S950-Disk-Format.pdf):
sixteen pages on the container, the MFM encoding, the directory and allocation table, the
sample and program records, and the arena they share. Everything in it was worked out by
reading the library and confirmed on hardware; this code is that document in executable
form.

It is mostly numbers taken from the corpus — *non-zero in 200 of 1110 samples*, *255 in all
341 S900 programs* — and numbers age. `docs/format-check.js` recounts them against the
disks:

```
node docs/format-check.js <directory of .hfe>
```

Thirty-eight claims, and a FAIL means the document has drifted rather than the disks. Mind
the two bases it counts on: figures given *of 1899* exclude `DSKA0049`, the one image whose
contents differ between the two sticks, and the document says so.

The PDF is printed from `docs/S950-Disk-Format.html`, so corrections go in the HTML and it
is printed again:

```
chrome --headless --no-pdf-header-footer --print-to-pdf=docs/S950-Disk-Format.pdf docs/S950-Disk-Format.html
```


