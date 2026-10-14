$ErrorActionPreference = 'Stop'
$tagCommit = 'd22f72308106ef62f558cbde16dacb1f21031ae3'
$source = git show "${tagCommit}:config/electron-builder.config.cjs"
if ($LASTEXITCODE -ne 0 -or ($source -join "`n") -match 'orca-agent-hook') {
  throw 'Recovery applies only to the tagged source that predates the native Windows hook.'
}
$version = git show "${tagCommit}:package.json" | ConvertFrom-Json
if ($version.version -ne '1.4.225') { throw 'Unexpected tagged version.' }

function Test-OfficialSignature([string]$path) {
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*CN=SignPath Foundation*') {
    throw "Invalid official signature: $path ($($signature.Status))"
  }
  Write-Host "Valid official signature: $path"
}
function Get-SignedInnerFile([string]$relative) {
  $paths = @((Join-Path 'signed-inner' $relative), (Join-Path 'signed-inner/signing-stage' $relative)) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
  if (@($paths).Count -ne 1) { throw "Missing or ambiguous signed inner file: $relative" }
  return (Get-Item -LiteralPath @($paths)[0]).FullName
}
function Assert-SameBytes([string]$left, [string]$right) {
  if ((Get-FileHash -LiteralPath $left -Algorithm SHA256).Hash -ne
      (Get-FileHash -LiteralPath $right -Algorithm SHA256).Hash) {
    throw "Signed artifact mismatch: $left versus $right"
  }
}

Get-SignedArtifact -OrganizationId c37aa192-a27a-4377-9c90-5d6c95912dc0 `
  -ApiToken $env:SIGNPATH_API_TOKEN -SigningRequestId '6313a12e-65c8-433d-8e61-85a6a1d816bc' `
  -OutputArtifactPath signed-inner.zip -Force -WaitForCompletionTimeoutInSeconds 300
Get-SignedArtifact -OrganizationId c37aa192-a27a-4377-9c90-5d6c95912dc0 `
  -ApiToken $env:SIGNPATH_API_TOKEN -SigningRequestId '09fd006a-0f43-414b-8c6d-fecaff870df7' `
  -OutputArtifactPath signed-windows.zip -Force -WaitForCompletionTimeoutInSeconds 300
Expand-Archive signed-inner.zip signed-inner -Force
Expand-Archive signed-windows.zip signed-windows -Force
$installers = @(Get-ChildItem signed-windows -Recurse -File -Filter 'orca-windows-setup.exe')
if ($installers.Count -ne 1) { throw 'Missing or ambiguous signed installer.' }
New-Item -ItemType Directory dist -Force | Out-Null
Copy-Item -LiteralPath $installers[0].FullName -Destination 'dist/orca-windows-setup.exe'
Test-OfficialSignature 'dist/orca-windows-setup.exe'

$sevenZip = (node config/scripts/resolve-7za-path.mjs | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $sevenZip)) { throw 'No payload extractor.' }
& $sevenZip x 'dist/orca-windows-setup.exe' '-odist/win-unpacked' -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Installer payload extraction failed.' }
$root = (Resolve-Path 'dist/win-unpacked').Path
$targets = @(Get-Content 'original-evidence/inner-signing-list.txt')
if ($targets.Count -lt 2) { throw 'Original signing list is empty.' }
foreach ($relative in $targets) {
  if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)') {
    throw 'Invalid original signing path.'
  }
  $shipped = Join-Path $root $relative
  $signed = Get-SignedInnerFile $relative
  Test-OfficialSignature $shipped
  Assert-SameBytes $shipped $signed
}
foreach ($relative in @('Orca.exe', 'resources/bin/orca.exe', 'resources/elevate.exe')) {
  Test-OfficialSignature (Join-Path $root $relative)
}
# Vendor-signed binaries retain their own signer; every shipped PE must still be valid.
foreach ($binary in Get-ChildItem $root -Recurse -File | Where-Object { $_.Extension -in @('.exe', '.dll', '.node') }) {
  $stream = [IO.File]::OpenRead($binary.FullName)
  try { $isPe = $stream.ReadByte() -eq 77 -and $stream.ReadByte() -eq 90 } finally { $stream.Dispose() }
  if (-not $isPe) { continue }
  if ((Get-AuthenticodeSignature -LiteralPath $binary.FullName).Status -ne 'Valid') {
    throw "Unsigned or invalid shipped binary: $($binary.FullName)"
  }
}

$signedUninstaller = Get-SignedInnerFile 'uninstaller/orca-uninstaller.exe'
Test-OfficialSignature $signedUninstaller
$shippedUninstaller = $null
$fullSevenZip = Join-Path $env:ProgramFiles '7-Zip/7z.exe'
if (Test-Path -LiteralPath $fullSevenZip) {
  & $fullSevenZip x -tnsis 'dist/orca-windows-setup.exe' '-onsis-extract' -y 2>&1 | Out-Null
  foreach ($candidate in Get-ChildItem nsis-extract -Recurse -File -Filter '*.exe') {
    if ((Get-FileHash -LiteralPath $candidate.FullName -Algorithm SHA256).Hash -eq
        (Get-FileHash -LiteralPath $signedUninstaller -Algorithm SHA256).Hash) {
      $shippedUninstaller = $candidate.FullName
      break
    }
  }
}
if (-not $shippedUninstaller) {
  # NSIS extraction can be incomplete; the disposable runner can inspect a real silent install.
  $installer = Start-Process -FilePath (Resolve-Path 'dist/orca-windows-setup.exe') -ArgumentList '/S' -WindowStyle Hidden -PassThru
  if (-not $installer.WaitForExit(300000)) {
    $installer | Stop-Process -Force
    throw 'Silent installer timed out.'
  }
  if ($installer.ExitCode -ne 0) { throw "Silent installer exited $($installer.ExitCode)." }
  $candidates = @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Recurse -File -Filter 'Uninstall*.exe' |
    Where-Object { $_.FullName -like '*Orca*' })
  if ($candidates.Count -ne 1) { throw 'Missing or ambiguous installed uninstaller.' }
  $shippedUninstaller = $candidates[0].FullName
}
Test-OfficialSignature $shippedUninstaller
Assert-SameBytes $shippedUninstaller $signedUninstaller
node config/scripts/verify-telemetry-constants.mjs
if ($LASTEXITCODE -ne 0) { throw 'Packaged telemetry verification failed.' }
node --input-type=module -e "import {extractFile} from '@electron/asar'; const p=JSON.parse(extractFile('dist/win-unpacked/resources/app.asar','package.json').toString()); if(p.version!=='1.4.225') throw Error('Wrong packaged version');"
if ($LASTEXITCODE -ne 0) { throw 'Packaged version verification failed.' }
node config/scripts/generate-windows-blockmap.mjs 'dist/orca-windows-setup.exe' 'dist/orca-windows-setup.exe.blockmap'
if ($LASTEXITCODE -ne 0) { throw 'Blockmap generation failed.' }
$bytes = [IO.File]::ReadAllBytes((Resolve-Path 'dist/orca-windows-setup.exe'))
$sha512 = [Convert]::ToBase64String([Security.Cryptography.SHA512]::HashData($bytes))
$blockmap = Get-Item 'dist/orca-windows-setup.exe.blockmap'
@"
version: 1.4.225
files:
  - url: orca-windows-setup.exe
    sha512: $sha512
    size: $($bytes.Length)
    blockMapSize: $($blockmap.Length)
path: orca-windows-setup.exe
sha512: $sha512
releaseDate: '2026-10-14T18:00:00.000Z'
"@ | Set-Content 'dist/latest.yml' -Encoding utf8NoBOM
"Verified original SignPath installer, $($targets.Count) signed inner files, all shipped PE signatures, shipped uninstaller, telemetry and version." |
  Set-Content 'recovery-evidence.txt'
Get-FileHash 'dist/orca-windows-setup.exe' -Algorithm SHA256 | Out-String | Add-Content 'recovery-evidence.txt'
