# Builds the current workspace, including uncommitted changes. No dependencies are installed.
[CmdletBinding()]
param(
    [string]$BuildVersion = '',
    [string]$OutputDirectory = '',
    [switch]$CheckOnly,
    [switch]$OpenOutput
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$scriptExitCode = 0
$locationPushed = $false
$buildLock = $null
$script:buildLogPath = $null
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Get-CanonicalVersion {
    param([string]$Value)
    if ($Value -notmatch '^\d+\.\d+\.\d+\.\d+$') {
        throw 'BuildVersion must contain four numeric parts, for example 3.4.0.18.'
    }
    $numbers = foreach ($part in $Value.Split('.')) {
        $number = 0
        if (-not [int]::TryParse($part, [ref]$number) -or $number -gt 65535) {
            throw 'Each BuildVersion part must be between 0 and 65535.'
        }
        $number
    }
    $canonical = $numbers -join '.'
    if ($canonical -eq '3.4.0.17') {
        throw '3.4.0.17 is reserved for the historical acceptance package. Choose another BuildVersion.'
    }
    return $canonical
}

function Test-SuccessfulOutput {
    param([string]$Directory, [string]$Version)
    try {
        $summary = Get-Content -LiteralPath (Join-Path $Directory 'build-summary.json') -Raw | ConvertFrom-Json
        $name = "Nova-Studio-$Version-offline-test-x64.exe"
        $installer = Join-Path $Directory $name
        return $summary.buildVersion -eq $Version -and $summary.installer -eq $name -and
            $summary.sha256 -match '^[a-f0-9]{64}$' -and
            (Test-Path -LiteralPath $installer -PathType Leaf) -and (Get-Item -LiteralPath $installer).Length -gt 0 -and
            (Get-Content -LiteralPath ($installer + '.sha256') -Raw).Trim() -eq "$($summary.sha256)  $name"
    }
    catch { return $false }
}

function Get-NextVersion {
    param([string]$Root)
    $last = 17
    if (Test-Path -LiteralPath $Root) {
        if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw 'The release root must be a directory.' }
        foreach ($directory in Get-ChildItem -LiteralPath $Root -Directory -Force) {
            if ($directory.Name -match '^3\.4\.0\.(\d+)$') {
                $revision = 0
                if ([int]::TryParse($Matches[1], [ref]$revision) -and $revision -ge 18 -and $revision -le 65535 -and
                    $revision -gt $last -and (Test-SuccessfulOutput $directory.FullName $directory.Name)) { $last = $revision }
            }
        }
    }
    $next = $last + 1
    while ($next -le 65535) {
        $version = "3.4.0.$next"
        if (-not (Test-Path -LiteralPath (Join-Path $Root $version))) { return $version }
        $next++
    }
    throw 'No free 3.4.0 build revision remains (maximum 65535). Specify another BuildVersion.'
}

function Get-BuildPlan {
    $version = if ($explicitVersion) { $requestedVersion } else { Get-NextVersion $defaultRoot }
    $path = if ($customOutput) { $customOutput } else { Join-Path $defaultRoot $version }
    $path = [IO.Path]::GetFullPath($path)
    if ($path -eq [IO.Path]::GetPathRoot($path)) { throw 'OutputDirectory must name a new child directory.' }
    $path = $path.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if (Test-Path -LiteralPath $path) {
        throw "The final output already exists: $path. Choose another explicit version or directory; no files were changed."
    }
    return [pscustomobject]@{ Version = $version; Output = $path; Root = [IO.Path]::GetDirectoryName($path) }
}

function Get-BuildTools {
    $npm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $null = Get-Command node.exe -CommandType Application -ErrorAction Stop
    $required = @(
        'package.json', 'frontend/package.json',
        'electron-builder.yml', 'electron-builder.offline.yml', 'electron-builder.offline-followup.yml',
        'node_modules/.bin/electron-builder.cmd', 'frontend/node_modules/.bin/next.cmd',
        'node_modules/electron/dist/electron.exe', 'node_modules/ffmpeg-static/ffmpeg.exe',
        'node_modules/ffmpeg-static/ffmpeg.exe.LICENSE', 'node_modules/ffmpeg-static/ffmpeg.exe.README'
    )
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $repository $relative) -PathType Leaf)) {
            throw "Required local file missing: $relative. Prepare dependencies separately; this script will not install them."
        }
    }
    return [pscustomobject]@{ Npm = $npm; Builder = (Join-Path $repository 'node_modules/.bin/electron-builder.cmd'); Config = (Join-Path $repository 'electron-builder.offline-followup.yml') }
}

function Write-BuildLog {
    param([string]$Message)
    Write-Host $Message
    if ($script:buildLogPath) { [IO.File]::AppendAllText($script:buildLogPath, $Message + [Environment]::NewLine, $utf8) }
}

function Invoke-CheckedCommand {
    param([string]$Command, [string[]]$Arguments, [string]$Label)
    Write-BuildLog "--- $Label ---"
    # PS 5.1 represents redirected native stderr as ErrorRecord. Log it, then use the process exit code.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Command @Arguments 2>&1 | ForEach-Object { Write-BuildLog $_.ToString() }
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    if ($code -ne 0) { throw "$Label failed (exit $code). Packaging stopped." }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This script requires Windows.' }
    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $defaultRoot = Join-Path $repository 'release-multi-reference'
    $explicitVersion = $PSBoundParameters.ContainsKey('BuildVersion')
    $requestedVersion = if ($explicitVersion) { Get-CanonicalVersion $BuildVersion } else { '' }
    $customOutput = ''
    if (-not [string]::IsNullOrWhiteSpace($OutputDirectory)) {
        $customOutput = if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $repository $OutputDirectory }
    }
    $plan = Get-BuildPlan
    if ($CheckOnly) {
        $null = Get-BuildTools
        Write-Host "Version: $($plan.Version)"
        Write-Host "Installer: $(Join-Path $plan.Output ('Nova-Studio-' + $plan.Version + '-offline-test-x64.exe'))"
        Write-Host 'Preflight passed. CheckOnly did not run a build, create files, reserve a version, or open a window.'
    }
    else {
        $null = [IO.Directory]::CreateDirectory($plan.Root)
        $lockPath = Join-Path $plan.Root '.nova-build.lock'
        try { $buildLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw "Another build holds the output lock: $lockPath. Wait for it to finish and retry." }
        # Re-select while holding the lock; CheckOnly and earlier observations never reserve a version.
        $plan = Get-BuildPlan
        $attemptName = '.attempt-' + $plan.Version + '-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
        $attemptPath = [IO.Path]::GetFullPath((Join-Path $plan.Root $attemptName))
        $null = [IO.Directory]::CreateDirectory($attemptPath)
        $script:buildLogPath = Join-Path $attemptPath 'build.log'
        [IO.File]::WriteAllText($script:buildLogPath, '', $utf8)
        $artifactName = 'Nova-Studio-' + $plan.Version + '-offline-test-x64.exe'
        $installerPath = Join-Path $attemptPath $artifactName
        Write-BuildLog "Version: $($plan.Version)"
        Write-BuildLog "Installer: $(Join-Path $plan.Output $artifactName)"
        Write-BuildLog "Attempt: $attemptPath"
        Write-BuildLog 'Source: current workspace, including uncommitted changes.'
        $tools = Get-BuildTools
        Push-Location -LiteralPath $repository
        $locationPushed = $true
        Invoke-CheckedCommand -Command $tools.Npm -Arguments @('run', 'build') -Label 'Frontend build'
        $builderArguments = @(
            '--config', $tools.Config, '--win', 'nsis', '--x64',
            "--config.buildVersion=$($plan.Version)",
            "--config.win.artifactName=$artifactName",
            "--config.directories.output=$attemptPath",
            "--config.nsis.uninstallDisplayName=Nova Studio $($plan.Version) - Local Test",
            '--publish', 'never'
        )
        Invoke-CheckedCommand -Command $tools.Builder -Arguments $builderArguments -Label 'Windows installer build'
        if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf) -or (Get-Item -LiteralPath $installerPath).Length -le 0) {
            throw 'Packaging reported success, but the expected installer is missing or empty.'
        }
        $algorithm = [Security.Cryptography.SHA256]::Create()
        $stream = $null
        try {
            $stream = [IO.File]::OpenRead($installerPath)
            $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        }
        finally {
            if ($null -ne $stream) { $stream.Dispose() }
            $algorithm.Dispose()
        }
        [IO.File]::WriteAllText(($installerPath + '.sha256'), "$hash  $artifactName`r`n", $utf8)
        $summary = [ordered]@{ buildVersion = $plan.Version; installer = $artifactName; sha256 = $hash }
        [IO.File]::WriteAllText((Join-Path $attemptPath 'build-summary.json'), ($summary | ConvertTo-Json), $utf8)
        # A directory rename is atomic only within this one parent; never move/delete an unchecked path.
        $absoluteRoot = [IO.Path]::GetFullPath($plan.Root)
        $absoluteAttempt = [IO.Path]::GetFullPath($attemptPath)
        $absoluteFinal = [IO.Path]::GetFullPath($plan.Output)
        if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetDirectoryName($absoluteAttempt), $absoluteRoot) -or
            -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetDirectoryName($absoluteFinal), $absoluteRoot) -or
            [StringComparer]::OrdinalIgnoreCase.Equals($absoluteAttempt, $absoluteFinal) -or
            ((Get-Item -LiteralPath $absoluteAttempt).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Attempt and final paths must be distinct ordinary directories under the same output parent.'
        }
        if (Test-Path -LiteralPath $absoluteFinal) { throw "The final output became occupied: $absoluteFinal. Attempt and log were retained." }
        [IO.Directory]::Move($absoluteAttempt, $absoluteFinal)
        $script:buildLogPath = Join-Path $absoluteFinal 'build.log'
        Write-BuildLog "SHA256: $hash"
        Write-BuildLog "Output directory: $absoluteFinal"
        Write-BuildLog "Build log: $script:buildLogPath"
        Write-BuildLog 'Installer and checksum saved. This is a local test build.'
        if ($OpenOutput) {
            try { Start-Process -FilePath explorer.exe -ArgumentList ('"' + $absoluteFinal + '"') | Out-Null }
            catch { Write-BuildLog 'Could not open File Explorer. Use the output directory printed above.' }
        }
    }
}
catch {
    $scriptExitCode = 1
    $message = $_.Exception.Message
    try { Write-BuildLog "[FAILED] $message" } catch { Write-Host "[FAILED] $message" }
    if ($script:buildLogPath) { Write-Host "Build log: $script:buildLogPath" }
    else { Write-Host 'No attempt log was created; the build did not start.' }
}
finally {
    if ($locationPushed) { Pop-Location }
    if ($null -ne $buildLock) { $buildLock.Dispose() }
}
exit $scriptExitCode
