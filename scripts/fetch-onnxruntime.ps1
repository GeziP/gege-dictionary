<#
.SYNOPSIS
  Puts what the screenshot OCR needs at run time into src-tauri/resources/ort:
  ONNX Runtime (the version pinned in src-tauri/ort-runtime.json, checked by SHA-256) and the
  Visual C++ runtime it is linked against.

.DESCRIPTION
  The app loads onnxruntime.dll from the folder of its executable, so that a PC that cannot load
  it loses the screenshot OCR and nothing else. Tauri copies everything in resources/ort next to
  the executable (bundle.resources in tauri.conf.json). The Visual C++ runtime goes along, because
  the app itself does not need it and a PC without the Visual C++ Redistributable could not load
  ONNX Runtime otherwise.

  Run it once after cloning, and again when ort-runtime.json changes. CI runs it before it builds.
  Nothing is downloaded when the folder is up to date.

.PARAMETER Force
  Fetch and unpack again even if the folder looks up to date.
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$pinFile = Join-Path $root 'src-tauri\ort-runtime.json'
$target = Join-Path $root 'src-tauri\resources\ort'
$crtNames = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll')
$licenseFiles = @('licenses\LICENSE-onnxruntime.txt', 'licenses\ThirdPartyNotices-onnxruntime.txt')

$pin = Get-Content -Raw -Encoding UTF8 -LiteralPath $pinFile | ConvertFrom-Json

function Get-Sha256([string]$path) {
    (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-UpToDate {
    $dll = Join-Path $target 'onnxruntime.dll'
    if (-not (Test-Path -LiteralPath $dll)) { return $false }
    if ((Get-Sha256 $dll) -ne $pin.dllSha256) { return $false }
    foreach ($name in ($crtNames + $licenseFiles)) {
        if (-not (Test-Path -LiteralPath (Join-Path $target $name))) { return $false }
    }
    return $true
}

# curl.exe comes with Windows 10 and later. Invoke-WebRequest of Windows PowerShell 5.1 is the
# fallback: behind some proxies it connects and then receives nothing. A transfer that stalls
# (less than 20 KB/s for 20 s: the connection is up and no data comes) is given up on and tried
# again, instead of being waited for until the time limit.
# There can be more than one curl.exe on the PATH (a GitHub runner has the one of Windows and the
# one of Git): the first is the one a shell would run, and the only one that can be called.
$curl = @(Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1
function Save-Download([string]$url, [string]$path) {
    if ($null -ne $curl) {
        & $curl.Source --location --fail --silent --show-error --connect-timeout 30 --max-time 600 `
            --speed-limit 20000 --speed-time 20 --output $path $url
        if ($LASTEXITCODE -ne 0) { throw "curl.exe exited with code $LASTEXITCODE" }
    } else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing -TimeoutSec 300
    }
}

function Save-Wheel([string]$url, [string]$expectedSha256, [string]$path) {
    $attempts = 5
    for ($attempt = 1; $attempt -le $attempts; $attempt++) {
        try {
            Save-Download $url $path
            $actual = Get-Sha256 $path
            if ($actual -ne $expectedSha256) {
                throw "SHA-256 of the download is $actual, but ort-runtime.json pins $expectedSha256"
            }
            return
        } catch {
            if ($attempt -eq $attempts) { throw "Could not fetch $url : $_" }
            Write-Host "Attempt $attempt failed ($_). Trying again."
            Start-Sleep -Seconds (3 * $attempt)
        }
    }
}

# The newest Visual C++ runtime that Visual Studio (or its Build Tools) carries for redistribution.
function Find-CrtDirectory {
    $vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
    $found = @()
    if (Test-Path -LiteralPath $vswhere) {
        foreach ($install in @(& $vswhere -all -products '*' -property installationPath)) {
            $redist = Join-Path $install 'VC\Redist\MSVC'
            if (-not (Test-Path -LiteralPath $redist)) { continue }
            foreach ($version in @(Get-ChildItem -LiteralPath $redist -Directory)) {
                $x64 = Join-Path $version.FullName 'x64'
                if (-not (Test-Path -LiteralPath $x64)) { continue }
                foreach ($crt in @(Get-ChildItem -LiteralPath $x64 -Directory -Filter 'Microsoft.VC*.CRT')) {
                    $missing = @($crtNames | Where-Object { -not (Test-Path -LiteralPath (Join-Path $crt.FullName $_)) })
                    if ($missing.Count -eq 0) { $found += $crt.FullName }
                }
            }
        }
    }
    if ($found.Count -eq 0) {
        throw ('No Visual C++ runtime to redistribute was found. Install the "MSVC v143 - VS 2022 C++ x64/x86 build tools" ' +
            'component of Visual Studio or its Build Tools (the Rust MSVC toolchain needs them anyway).')
    }
    $found | Sort-Object { [version](Get-Item -LiteralPath (Join-Path $_ 'vcruntime140.dll')).VersionInfo.FileVersion } -Descending |
        Select-Object -First 1
}

if (-not $Force -and (Test-UpToDate)) {
    Write-Host "ONNX Runtime $($pin.version) is already in $target"
    exit 0
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("gege-ort-" + [Guid]::NewGuid().ToString('N'))
$staging = Join-Path $work 'ort'
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
    $wheel = Join-Path $work 'onnxruntime.whl'
    Write-Host "Fetching ONNX Runtime $($pin.version) ..."
    Save-Wheel $pin.wheelUrl $pin.wheelSha256 $wheel

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($wheel)
    try {
        $wanted = @(
            @{ From = 'onnxruntime/capi/onnxruntime.dll'; To = 'onnxruntime.dll' },
            @{ From = 'onnxruntime/LICENSE'; To = 'licenses\LICENSE-onnxruntime.txt' },
            @{ From = 'onnxruntime/ThirdPartyNotices.txt'; To = 'licenses\ThirdPartyNotices-onnxruntime.txt' }
        )
        New-Item -ItemType Directory -Path (Join-Path $staging 'licenses') -Force | Out-Null
        foreach ($item in $wanted) {
            $entry = $zip.GetEntry($item.From)
            if ($null -eq $entry) { throw "The wheel has no $($item.From)" }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $staging $item.To), $true)
        }
    } finally {
        $zip.Dispose()
    }

    $dllSha256 = Get-Sha256 (Join-Path $staging 'onnxruntime.dll')
    if ($dllSha256 -ne $pin.dllSha256) {
        throw "onnxruntime.dll in the wheel has SHA-256 $dllSha256, but ort-runtime.json pins $($pin.dllSha256)"
    }

    $crtDirectory = Find-CrtDirectory
    foreach ($name in $crtNames) {
        Copy-Item -LiteralPath (Join-Path $crtDirectory $name) -Destination (Join-Path $staging $name)
    }
    $crtVersion = (Get-Item -LiteralPath (Join-Path $staging 'vcruntime140.dll')).VersionInfo.FileVersion

    $readme = @(
        'Files that the screenshot OCR of Gege Dictionary loads at run time:',
        '',
        "  onnxruntime.dll   ONNX Runtime $($pin.version) (MIT license: LICENSE-onnxruntime.txt and ThirdPartyNotices-onnxruntime.txt in this folder)",
        "  vcruntime140*.dll, msvcp140*.dll   Microsoft Visual C++ runtime $crtVersion, redistributed as part of the app",
        '',
        "onnxruntime.dll SHA-256: $dllSha256"
    )
    Set-Content -LiteralPath (Join-Path $staging 'licenses\README-runtime.txt') -Value $readme -Encoding ASCII

    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Move-Item -LiteralPath $staging -Destination $target

    Write-Host "ONNX Runtime $($pin.version) and the Visual C++ runtime $crtVersion are in $target"
    Get-ChildItem -LiteralPath $target -Recurse -File | ForEach-Object {
        Write-Host ("  {0,-48} {1,10:N0} bytes" -f $_.FullName.Substring($target.Length + 1), $_.Length)
    }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
