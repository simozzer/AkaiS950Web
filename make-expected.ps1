# Dumps what the C# library sees, so the JavaScript port can be diffed against it.
$ErrorActionPreference='Stop'
$L='C:\Users\simon\AkaiS950List'
Add-Type -Path "$L\Hfe.cs","$L\HfeWrite.cs","$L\AkaiDisk.cs" -ReferencedAssemblies System.Core
$AD=[AkaiS950List.AkaiDisk]

$dir = if ($args.Count -gt 0) { $args[0] } else { 'E:\' }
$out = [ordered]@{}

foreach ($f in (Get-ChildItem (Join-Path $dir '*') -Include *.hfe,*.img | Sort-Object Name)) {
  $d = $AD::Load($f.FullName)
  $files = @()

  foreach ($e in $d.Entries) {
    $rec = [ordered]@{ name=$e.Name; type=[string]$e.Type; length=[int]$e.Length; start=[int]$e.StartBlock }

    if ($e.Type -eq 'S') {
      $w = $d.SampleWords12($e)
      # Fletcher-style checksum over the 12-bit words, matching hashWords() in
      # verify.js. Chosen over FNV because the intermediates stay small: both
      # languages compute it exactly, with no overflow to worry about.
      $a = [int64]1; $b = [int64]0
      foreach ($v in $w) {
        $a = ($a + ($v -band 0xFFFF)) % 65521
        $b = ($b + $a) % 65521
      }
      $h = $b * 65536 + $a
      $rec.words  = [int]$w.Length
      $rec.rate   = [int]$e.SampleRate
      $rec.tuning = [int]$e.Tuning
      $rec.hash   = [int64]$h
    }
    elseif ($e.Type -eq 'P') {
      $rec.keygroups = [int]$AD::KeygroupCount($e)
    }
    $files += [pscustomobject]$rec
  }

  $out[$f.Name] = [pscustomobject]@{
    badCrc  = [int]$d.BadCrcSectors
    missing = [int]$d.MissingSectors
    files   = $files
  }
  Write-Host ("  {0}  {1} files" -f $f.Name, $files.Count)
}

$json = $out | ConvertTo-Json -Depth 6
Set-Content -Path (Join-Path $PSScriptRoot 'expected.json') -Value $json -Encoding UTF8
"wrote expected.json for {0} disk(s)" -f $out.Count
