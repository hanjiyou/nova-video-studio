param(
 [Parameter(Mandatory=$true)][ValidateSet('upgrade','uninstall','reinstall')][string]$Action,
 [Parameter(Mandatory=$true)][string]$TestRoot,
 [Parameter(Mandatory=$true)][string]$Profile,
 [string]$Installer = 'E:\Learn\AI\nova-image-studio\release-t16\Nova-Studio-3.4.0-offline-test-x64.exe'
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($TestRoot)
$install=[IO.Path]::GetFullPath((Join-Path $root '程序 中文 空格'))
$profilePath=[IO.Path]::GetFullPath($Profile)
if(-not $install.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Install target escaped explicit test root'}
if($profilePath.StartsWith($install+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Profile must be outside installation'}
if(-not (Test-Path -LiteralPath (Join-Path $profilePath '保留验证 sentinel.txt'))){throw 'Explicit synthetic profile sentinel required'}
$registration=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object {$_.DisplayName -eq 'Nova Studio 3.4.0 - Local Offline Test'})
if($Action -ne 'reinstall'){
 $expectedUninstaller='"'+(Join-Path $install 'Uninstall Nova Studio Offline Test.exe')+'"'
 if($registration.Count -ne 1 -or -not $registration[0].UninstallString.StartsWith($expectedUninstaller,[StringComparison]::OrdinalIgnoreCase)){throw 'Existing registration does not match the isolated install target'}
} elseif($registration.Count){throw 'Refusing to reinstall over unexpected registration'}
function ProfileSnapshot {
 $items=@(Get-ChildItem -LiteralPath $profilePath -File -Recurse | Sort-Object FullName | ForEach-Object { @{file=$_.FullName.Substring($profilePath.Length);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant();bytes=$_.Length} })
 return ($items | ConvertTo-Json -Depth 3 -Compress)
}
$before=ProfileSnapshot
$started=[DateTime]::UtcNow.ToString('o')
if($Action -eq 'uninstall'){
 $executable=Join-Path $install 'Uninstall Nova Studio Offline Test.exe'
 if(-not (Test-Path -LiteralPath $executable)){throw 'Isolated uninstaller missing'}
 # Deliberately never pass the destructive --delete-app-data flag.
 $arguments=@('/S','/currentuser')
}else{
 $executable=[IO.Path]::GetFullPath($Installer)
 $arguments=@('/S','/currentuser',('/D='+$install))
}
$process=Start-Process -FilePath $executable -ArgumentList $arguments -PassThru -Wait -WindowStyle Hidden
$end=(Get-Date).AddSeconds(15)
if($Action -eq 'uninstall'){while((Test-Path -LiteralPath (Join-Path $install 'Nova Studio Offline Test.exe')) -and (Get-Date) -lt $end){Start-Sleep -Milliseconds 100}}
$after=ProfileSnapshot
$record=[ordered]@{action=$Action;startedAt=$started;finishedAt=[DateTime]::UtcNow.ToString('o');identity=(& whoami.exe);exitCode=$process.ExitCode;installerSha256=(Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant();installDirectory=$install;profile=$profilePath;fullProfileBytesUnchanged=($before -ceq $after);sentinelRetained=(Test-Path -LiteralPath (Join-Path $profilePath '保留验证 sentinel.txt'));installedExePresent=(Test-Path -LiteralPath (Join-Path $install 'Nova Studio Offline Test.exe'));registrationCountAfter=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object {$_.DisplayName -eq 'Nova Studio 3.4.0 - Local Offline Test'}).Count}
$record.status=if($record.exitCode -eq 0 -and $record.fullProfileBytesUnchanged -and $record.sentinelRetained -and ($record.installedExePresent -eq ($Action -ne 'uninstall'))){'passed'}else{'failed'}
$record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root ($Action+'-record.json')) -Encoding utf8
$record | ConvertTo-Json -Depth 5
if($record.status -ne 'passed'){exit 1}
