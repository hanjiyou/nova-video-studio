param([string]$Output = 'release-t16/source-materials', [switch]$Additional)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = [IO.Path]::GetFullPath((Join-Path $root $Output))
if (-not $destination.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must remain inside this repository' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$materials = @(
 @{name='FFmpeg'; revision='e38092ef93'; repo='FFmpeg/FFmpeg'},
 @{name='ffmpeg-static'; revision='b6.1.1'; repo='eugeneware/ffmpeg-static'},
 @{name='x265'; revision='ce8642f22'; repo='videolan/x265'},
 @{name='libass'; revision='c047dd2'; repo='libass/libass'},
 @{name='harfbuzz'; revision='d455066ad'; repo='harfbuzz/harfbuzz'},
 @{name='fribidi'; revision='5b9a242'; repo='fribidi/fribidi'},
 @{name='libwebp'; revision='e78e924f'; repo='webmproject/libwebp'},
 @{name='opus'; revision='c8549975'; repo='xiph/opus'},
 @{name='vorbis'; revision='84c02369'; repo='xiph/vorbis'},
 @{name='SDL'; revision='0f8f4f676'; repo='libsdl-org/SDL'},
 @{name='srt'; revision='02acd18'; repo='Haivision/srt'},
 @{name='vmaf'; revision='cf67786b'; repo='Netflix/vmaf'},
 @{name='zimg'; revision='7143181'; repo='sekrit-twc/zimg'},
 @{name='ffnvcodec'; revision='75f032b'; repo='FFmpeg/nv-codec-headers'},
 @{name='vidstab'; revision='05829db'; repo='georgmartius/vid.stab'},
 @{name='AviSynthPlus'; revision='eb3c4330'; repo='AviSynth/AviSynthPlus'}
)
if ($Additional) {
 $materials = @(
 @{name='x264'; revision='c1c9931'; repo='mirror/x264'},
 @{name='libvpx'; revision='655da33b8'; repo='webmproject/libvpx'},
 @{name='speex'; revision='3693431'; repo='xiph/speex'},
 @{name='openmpt'; revision='7ec8c1440'; repo='OpenMPT/openmpt'},
 @{name='AMF'; revision='v1.4.32'; repo='GPUOpen-LibrariesAndSDKs/AMF'},
 @{name='freetype'; revision='VER-2-13-2'; repo='freetype/freetype'},
 @{name='libgme'; revision='0.6.3'; repo='libgme/game-music-emu'},
 @{name='rubberband'; revision='v1.8.1'; repo='breakfastquay/rubberband'},
 @{name='zeromq'; revision='v4.3.5'; repo='zeromq/libzmq'},
 @{name='libtheora'; revision='v1.1.1'; repo='xiph/theora'},
 @{name='libssh'; revision='libssh-0.10.4'; repo='libssh/libssh-mirror'},
 @{name='aom'; revision='0eeb62d344'; url='https://aomedia.googlesource.com/aom/+archive/0eeb62d344.tar.gz'},
 @{name='gsm'; revision='1.0.22'; url='https://www.quut.com/gsm/gsm-1.0.22.tar.gz'},
 @{name='xvid'; revision='1.3.7'; url='https://downloads.xvid.com/downloads/xvidcore-1.3.7.tar.gz'},
 @{name='lame'; revision='3.100'; url='https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz'},
 @{name='opencore-amr'; revision='0.1.6'; url='https://downloads.sourceforge.net/project/opencore-amr/opencore-amr/opencore-amr-0.1.6.tar.gz'},
 @{name='vo-amrwbenc'; revision='0.1.3'; url='https://downloads.sourceforge.net/project/opencore-amr/vo-amrwbenc/vo-amrwbenc-0.1.3.tar.gz'}
 )
}
$results = @()
if ($Additional -and (Test-Path -LiteralPath (Join-Path $root 'docs/implementation/t16-evidence/source-materials.json'))) { $results = @((Get-Content -LiteralPath (Join-Path $root 'docs/implementation/t16-evidence/source-materials.json') -Raw | ConvertFrom-Json).materials) }
foreach ($material in $materials) {
 $url = if ($material.url) { $material.url } else { 'https://codeload.github.com/' + $material.repo + '/tar.gz/' + $material.revision }
 $file = Join-Path $destination ($material.name + '-' + $material.revision + '.tar.gz')
 $record = [ordered]@{name=$material.name;revision=$material.revision;url=$url;scope='README revision upstream archive only; exact upstream patches/configuration/toolchain not proven. ffmpeg-static is release packaging, not the Gyan build recipe.';file=$file;startedAt=[DateTime]::UtcNow.ToString('o')}
 if (Test-Path -LiteralPath $file) { throw "Refusing to overwrite existing download $file" }
 $curlOutput = & curl.exe --proxy http://127.0.0.1:7898 --fail --location --silent --show-error --max-time 90 --output $file --write-out '%{http_code} %{url_effective}' $url 2>&1
 $record.exitCode=$LASTEXITCODE
 $record.transport=[string]::Join([Environment]::NewLine,$curlOutput)
 if ($record.exitCode -eq 0) {
   $record.bytes=(Get-Item -LiteralPath $file).Length
   $record.sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
   $entries = @(& tar.exe -tf $file 2>$null)
   $record.archiveExit=$LASTEXITCODE
   $record.archiveEntries=$entries.Count
   $record.archiveRoot=if($entries.Count){$entries[0]}else{$null}
   $record.containsBuildMaterials=@($entries | Where-Object {$_ -match '/(configure|CMakeLists.txt|Makefile|COPYING|LICENSE[^/]*)$'} | Select-Object -First 12)
   $record.status=if($record.archiveExit -eq 0){'collected_upstream_archive_only'}else{'invalid_archive'}
 } else { $record.status='download_failed' }
 $record.finishedAt=[DateTime]::UtcNow.ToString('o')
 $results += $record
 [IO.File]::WriteAllText((Join-Path $root 'docs/implementation/t16-evidence/source-materials.json'), (@{status='partial_not_corresponding_source_complete';publicDistributionAllowed=$false;materials=$results} | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
 Write-Output ($material.name + ': ' + $record.status)
}
