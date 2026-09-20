# Builds AkaiS950Web.zip - what "Download source" hands the user.
#
# Only what someone needs to run the app and check it: the five app files, a way to
# serve them, the browser self-test and the Node checkers. The scratch scripts from
# working out the format stay out, and so does expected.json, which is 880 KB of
# manifest that only matters when comparing against the C# build.
#
#   pwsh -File makezip.ps1

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$zip = Join-Path $here 'AkaiS950Web.zip'

$include = @(
  # the app
  'index.html', 'app.js', 'akai.js', 'audio.js', 'style.css',
  # running it locally
  'serve.js', 'README.md',
  # checking it
  'selftest.html', 'fsck.js', 'arenatest.js', 'deltest.js', 'slicetest.js', 'progtest.js',
  'looptest.js',
  'imgtest.js', 'vcftest.js', 'vcfcal.js', 'keycal.js', 'keycaltest.js',
  'benchplan.js', 'makemidi.js', 'miditest.js', 'benchcal.js', 'emulate.js', 'benchdisk.js'
)

$missing = $include | Where-Object { -not (Test-Path (Join-Path $here $_)) }
if ($missing) { throw "missing: $($missing -join ', ')" }

$staging = Join-Path ([IO.Path]::GetTempPath()) ("akaiweb_" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null

foreach ($f in $include) { Copy-Item (Join-Path $here $f) (Join-Path $staging $f) }

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal

Remove-Item $staging -Recurse -Force

$size = [Math]::Round((Get-Item $zip).Length / 1KB)
"AkaiS950Web.zip  $size KB  ($($include.Count) files)"

# the build stamp inside must match the one the page shows
$build = (Select-String -Path (Join-Path $here 'akai.js') -Pattern "Akai\.BUILD = '([^']+)'").Matches[0].Groups[1].Value
"build $build"
