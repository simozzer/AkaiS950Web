# Builds AkaiS950Web.zip - what "Download source" hands the user.
#
# Only what someone needs to run the app and check it: the app itself, a way to serve it,
# the browser self-test and the Node checkers, in the same shape as the repository. The
# scratch scripts from working out the format stay out, and so does expected.json, which is
# 880 KB of manifest that only matters when comparing against the C# build.
#
# The zip is written to the repository root, beside index.html, because that is where the
# page's "Download source" link looks for it.
#
#   pwsh -File tools/makezip.ps1

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$zip  = Join-Path $root 'AkaiS950Web.zip'

# paths are relative to the repository root, and are kept in the zip
$include = @(
  # the app
  'index.html', 'app.js', 'akai.js', 'audio.js', 'style.css',
  # running it locally
  'serve.js', 'README.md',
  # checking it
  'test/selftest.html', 'test/fsck.js', 'test/arenatest.js', 'test/deltest.js',
  'test/slicetest.js', 'test/progtest.js', 'test/imgtest.js', 'test/vcftest.js',
  'test/keycaltest.js', 'test/miditest.js', 'test/looptest.js',
  # the calibration rig the tests lean on
  'tools/vcfcal.js', 'tools/keycal.js', 'tools/benchplan.js', 'tools/makemidi.js',
  'tools/benchcal.js', 'tools/emulate.js', 'tools/benchdisk.js',
  # the format, written up
  'docs/S950-Disk-Format.pdf', 'docs/tutorial.md'
)

$missing = $include | Where-Object { -not (Test-Path (Join-Path $root $_)) }
if ($missing) { throw "missing: $($missing -join ', ')" }

$staging = Join-Path ([IO.Path]::GetTempPath()) ("akaiweb_" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null

foreach ($f in $include) {
  $dest = Join-Path $staging $f
  $dir = Split-Path -Parent $dest
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Copy-Item (Join-Path $root $f) $dest
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal

Remove-Item $staging -Recurse -Force

$size = [Math]::Round((Get-Item $zip).Length / 1KB)
"AkaiS950Web.zip  $size KB  ($($include.Count) files)"

# the build stamp inside must match the one the page shows
$build = (Select-String -Path (Join-Path $root 'akai.js') -Pattern "Akai\.BUILD = '([^']+)'").Matches[0].Groups[1].Value
"build $build"
