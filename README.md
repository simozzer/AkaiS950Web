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
`selftest.html` needs to load a disk image. For either, serve the folder — any static
server will do:

```
node serve.js               http://localhost:8080/   (included; takes a port: node serve.js 8099)
python -m http.server 8000  http://localhost:8000/   (python3 on a Mac or Linux)
npx serve                   prints its own address
```

Then open the address it prints rather than the file. The self-test wants a disk to work
on, named in the query string:

```
http://localhost:8080/selftest.html?disk=DSKA0000-bench.hfe
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
- Creates and deletes programs, adds and removes keygroups, renames and deletes samples
- Stretches a sample to a new tempo, halves its rate, trims leading silence
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
powershell -File make-expected.ps1 E:\     # what the C# sees, as JSON
node verify.js E:\                         # what the JavaScript sees, diffed against it
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

`selftest.html` drives the real interface the way a person would — it drops a disk image on
the page, clicks through the tree, and checks that the panes actually filled in and the
canvases actually drew. It also runs the identity round-trip a second time, in the browser.

```
node serve.js 8099
# then open http://localhost:8099/selftest.html?disk=test.hfe
```

with a disk image copied into this folder as `test.hfe`. It reports PASS or FAIL in the page
title, so it can be run headless:

```
msedge --headless --dump-dom "http://localhost:8099/selftest.html?disk=test.hfe"
```

## Containers

Both are read; both can be written.

- **HFE** — the Gotek/HxC container. Written by patching the sectors of the HFE the disk
  was opened from, in place: every Akai sector is 1024 bytes, so nothing moves and the MFM
  bitstream, gaps and sync marks around it are left exactly as they were.
- **IMG** — the bare 800K sector image: 80 cylinders x 2 sides x 5 sectors x 1024 bytes,
  819,200 bytes. This is what `Disk.image` already holds, so writing it is a copy and
  converting an HFE to it is lossless — `imgtest.js` checks that byte for byte, audio
  included, on the whole corpus.

`.img` to `.hfe` works too: with no bitstream to patch, the container is built from
scratch — header, track list, and for every one of the 160 track/sides the gaps, sync
fields, index and address marks, CRCs and clock bits.

The layout was not assumed from the IBM System 34 spec but measured from the library,
where all 101 disks agree exactly: one identical 512-byte header, 25000 bytes per track,
sectors 1..5 with no skew, the first ID address mark at bit 4928 of every side, and the
gap fill running on through the 44 bytes of padding at the end of each side's last
256-byte chunk. Because of that, the encoder is held to reproduction rather than mere
validity: `imgtest.js` rebuilds every disk from its sectors alone and requires the result
to match the original file **byte for byte**. All 101 do.

## Files

| File | Contents |
|---|---|
| `akai.js` | the format: HFE, MFM decode and encode, filesystem, samples, programs. No DOM, no Node — the same file runs in both |
| `app.js` | the interface: tree, canvases, editors, Web Audio |
| `audio.js` | decoding, rate conversion, 12-bit quantising, WSOLA time stretch |
| `index.html`, `style.css` | the page |
| `verify.js` | Node harness that checks the port against the corpus |
| `fsck.js` | structural checker: CRCs, chains, the arena, program headers, zone pointers |
| `arenatest.js` | churns keygroups across the corpus, checking the arena never drifts |
| `deltest.js` | deletes a sample from every image and checks what is left |
| `slicetest.js` | slices a break on every image with room for it |
| `progtest.js` | creates and deletes a program on every image, and checks the round trip |
| `imgtest.js` | converts every image to raw `.img` and checks nothing is lost |
| `vcftest.js` | measures the VCF - flat passband, -3 dB at cutoff, 36 dB/octave - and checks the calibrator recovers a mapping it is not given |
| `vcfcal.js` | derives the real cutoff mapping from recordings of the hardware |
| `makezip.ps1` | builds the downloadable source bundle |
| `make-expected.ps1` | dumps what the C# sees, for `verify.js` to diff against |
| `looptest.js` | the loop finder, against the loops the library shipped with |
| `selftest.html` | end-to-end test of the interface |
| `serve.js` | static server, for testing or hosting |
| `docs/tutorial.md` | the walkthrough: open a disk, change something, write it back |
| `docs/S950-Disk-Format.pdf` | how the format works, in fourteen pages |
| `docs/shots.js` | regenerates the screenshots by driving a real browser |

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

`looptest.js` measures it against the loops somebody chose by ear on the machine, using
the same join measure for both. Across the library it averages **0.881 where the shipped
loops average 0.793** — better on 110 samples, as good on 158, worse on 30, and those 30
are noise where both answers score near zero.

```
node looptest.js <directory of .hfe> [modes]
```

A note on the loop mode, which the tool now changes properly: how many 10-byte
descriptors a sample takes in the table after the keygroup arena depends on it — a
looping sample takes one more than a one-shot — so changing the mode moves the descriptor
pointer of every sample after it. Writing the byte alone, which is what this did before,
broke that chain on 95 of the 96 library disks it was tried on. `fsck.js` checks the chain
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
(WSOLA time stretch, pitch preserved), and **Rename** on the file heading — which retargets
every keygroup zone that named the sample.

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

`deltest.js` checks this against the whole corpus: it deletes a sample from the middle of
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

## Calibrating the emulation

The filter and envelope model is measured against the machine rather than guessed at.
Everything the measurement needs is generated from one file, `benchplan.js`, so the disk,
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
node benchdisk.js check DSKA0000-bench.hfe   # the disk matches the plan
node makemidi.js                             # writes AkaiCalibration.mid
node miditest.js                             # the MIDI file matches the plan
```

`benchdisk.js build <in> <out>` writes the programme the plan describes, if the two ever
part company.

### Recording the sampler

Load the disk, select `CALIB`, point a sequencer at the S950 on MIDI channel 1, record
the audio output and play `AkaiCalibration.mid`. It runs for 109 seconds. Then:

```
node benchcal.js take.wav
```

which reports every constant the take settles, and says so plainly where a measurement
is against a stop and means nothing.

### Rendering the emulation

The same run, through the model instead of the machine. `emulate.js` renders it offline
to a 32-bit float WAV - nothing quantised and nothing clipped, however loud the run is,
since the measurements are all ratios and a clipped take would be measuring its own
clipping.

```
node emulate.js emulated.wav
node benchcal.js emulated.wav
```

Run the two reports side by side and hardware and emulation differ only where the model
is wrong. It caught a real error in the cutoff curve.

What it does not check is the playback path. `emulate.js` re-implements the envelope in
a loop of its own, so it settles the model's constants and not the thing you actually
hear - Web Audio's scheduling, the voice handling, the release. The page used to carry a
**Record** button for exactly that, capturing what it played over a MIDI loopback for
`benchcal.js` to read; it was removed once the model stopped moving. Recording the page
through the operating system, or restoring the button from the history, is the way back
to that check if the playback path ever comes under suspicion again.

The format itself is written up in [**S950-Disk-Format.pdf**](docs/S950-Disk-Format.pdf):
fourteen pages on the container, the MFM encoding, the directory and allocation table, the
sample and program records, and the arena they share. Everything in it was worked out by
reading the library and confirmed on hardware; this code is that document in executable
form.


