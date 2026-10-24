# Builds the current workspace, including uncommitted changes. No dependencies are installed.
[CmdletBinding()]
param(
    [string]$BuildVersion = '3.4.0.18',
    [string]$OutputDirectory = '',
    [switch]$CheckOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$scriptExitCode = 0
$locationPushed = $false

function Invoke-CheckedCommand {
    param([string]$Command, [string[]]$Arguments, [string]$Label)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed (exit $LASTEXITCODE). Packaging stopped."
    }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This script requires Windows.' }
    if ($BuildVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
        throw 'BuildVersion must contain four numeric parts, for example 3.4.0.18.'
    }
    foreach ($part in $BuildVersion.Split('.')) {
        $number = 0
        if (-not [int]::TryParse($part, [ref]$number) -or $number -gt 65535) {
            throw 'Each BuildVersion part must be between 0 and 65535.'
        }
    }
    if ($BuildVersion -eq '3.4.0.17') {
        throw '3.4.0.17 is reserved for the historical acceptance package. Choose another BuildVersion.'
    }

    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
        $OutputDirectory = Join-Path 'release-multi-reference' $BuildVersion
    }
    if (-not [IO.Path]::IsPathRooted($OutputDirectory)) {
        $OutputDirectory = Join-Path $repository $OutputDirectory
    }
    $outputPath = [IO.Path]::GetFullPath($OutputDirectory)
    $artifactName = "Nova-Studio-$BuildVersion-offline-test-x64.exe"
    $installerPath = Join-Path $outputPath $artifactName

    if (Test-Path -LiteralPath $installerPath) {
        throw 'The target installer already exists. Choose another BuildVersion or OutputDirectory.'
    }
    if (Test-Path -LiteralPath $outputPath) {
        if (-not (Test-Path -LiteralPath $outputPath -PathType Container)) {
            throw 'OutputDirectory must be a directory.'
        }
        if (@(Get-ChildItem -LiteralPath $outputPath -Force).Count -gt 0) {
            throw 'OutputDirectory is not empty. Choose another BuildVersion or OutputDirectory; no files were removed.'
        }
    }

    $npmCommand = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $null = Get-Command node.exe -CommandType Application -ErrorAction Stop
    $builderCommand = Join-Path $repository 'node_modules/.bin/electron-builder.cmd'
    $configPath = Join-Path $repository 'electron-builder.offline-followup.yml'
    $requiredFiles = @(
        'package.json', 'frontend/package.json',
        'electron-builder.yml', 'electron-builder.offline.yml', 'electron-builder.offline-followup.yml',
        'node_modules/.bin/electron-builder.cmd', 'frontend/node_modules/.bin/next.cmd',
        'node_modules/electron/dist/electron.exe', 'node_modules/ffmpeg-static/ffmpeg.exe',
        'node_modules/ffmpeg-static/ffmpeg.exe.LICENSE', 'node_modules/ffmpeg-static/ffmpeg.exe.README'
    )
    foreach ($relativePath in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $repository $relativePath) -PathType Leaf)) {
            throw "Required local file missing: $relativePath. Prepare dependencies separately; this script will not install them."
        }
    }

    Write-Host "Version: $BuildVersion"
    Write-Host "Installer: $installerPath"
    Write-Host 'Source: current workspace, including uncommitted changes.'
    if ($CheckOnly) {
        Write-Host 'Preflight passed. CheckOnly did not run a build or create output files.'
    }
    else {
        Push-Location -LiteralPath $repository
        $locationPushed = $true
        Invoke-CheckedCommand -Command $npmCommand -Arguments @('run', 'build') -Label 'Frontend build'
        # Recheck after the frontend build so a newly occupied destination is not overwritten.
        if (Test-Path -LiteralPath $outputPath) {
            if (@(Get-ChildItem -LiteralPath $outputPath -Force).Count -gt 0) {
                throw 'OutputDirectory became occupied. Choose another BuildVersion or OutputDirectory.'
            }
        }
        $builderArguments = @(
            '--config', $configPath, '--win', 'nsis', '--x64',
            "--config.buildVersion=$BuildVersion",
            "--config.win.artifactName=$artifactName",
            "--config.directories.output=$outputPath",
            "--config.nsis.uninstallDisplayName=Nova Studio $BuildVersion - Local Test",
            '--publish', 'never'
        )
        Invoke-CheckedCommand -Command $builderCommand -Arguments $builderArguments -Label 'Windows installer build'
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
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText(($installerPath + '.sha256'), "$hash  $artifactName`r`n", $utf8)
        $summary = [ordered]@{ buildVersion = $BuildVersion; installer = $artifactName; sha256 = $hash }
        [IO.File]::WriteAllText((Join-Path $outputPath 'build-summary.json'), ($summary | ConvertTo-Json), $utf8)
        Write-Host "SHA256: $hash"
        Write-Host 'Installer and checksum saved. This is a local test build.'
    }
}
catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    $scriptExitCode = 1
}
finally {
    if ($locationPushed) { Pop-Location }
}
exit $scriptExitCode