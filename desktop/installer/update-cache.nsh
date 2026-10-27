# Callbacks can expand these macros before electron-builder loads its headers.
!include "LogicLib.nsh"
# Cache only; these macros never install an application or touch its data.
!ifndef BUILD_UNINSTALLER
Var novaCacheRoot
Var novaCacheHandle
Var novaCacheReady
!endif
!macro novaCloseInstallerCache
  ${If} $novaCacheHandle != 0
    System::Call 'kernel32::CloseHandle(p $novaCacheHandle)'
    StrCpy $novaCacheHandle 0
  ${EndIf}
!macroend
!macro novaCheckCacheFile NAME
  System::Call 'kernel32::GetFileAttributesW(w "$novaCacheRoot\${NAME}") i.r0'
  ${If} $0 != -1
    IntOp $0 $0 & 0x410
    ${If} $0 != 0
      !insertmacro novaCloseInstallerCache
      Abort "Unsafe update cache file."
    ${EndIf}
  ${EndIf}
!macroend
!macro novaPrepareInstallerCache ROOT
  StrCpy $novaCacheRoot "${ROOT}"
  StrCpy $novaCacheHandle 0
  StrCpy $novaCacheReady 0
  System::Call 'kernel32::GetFileAttributesW(w "$novaCacheRoot") i.r0'
  ${If} $0 != -1
    IntOp $1 $0 & 0x400
    IntOp $0 $0 & 0x10
    ${If} $1 != 0
    ${OrIf} $0 == 0
      Abort "Unsafe update cache directory."
    ${EndIf}
  ${EndIf}
    !insertmacro novaCheckCacheFile "installer.next.exe"
    !insertmacro novaCheckCacheFile "installer.exe"
    !insertmacro novaCheckCacheFile "installer-state.json"
    !insertmacro novaCheckCacheFile "installer-state.next.json"
    !insertmacro novaCheckCacheFile "current.blockmap"
  CreateDirectory "$novaCacheRoot"
  # No FILE_SHARE_DELETE: hold the cache directory until publication.
  System::Call 'kernel32::CreateFileW(w "$novaCacheRoot", i 0, i 3, p 0, i 3, i 0x02200000, p 0) p.r0'
  ${If} $0 != -1
    StrCpy $novaCacheHandle $0

    Delete "$novaCacheRoot\installer.next.exe"
    ${IfNot} ${FileExists} "$novaCacheRoot\installer.next.exe"
      StrCpy $novaCacheReady 1
    ${EndIf}
  ${EndIf}
!macroend
!macro novaPublishInstallerCache SOURCE
  ${If} $novaCacheHandle != 0
    Delete "$novaCacheRoot\installer-state.json"
    Delete "$novaCacheRoot\current.blockmap"
  ${EndIf}
  ${If} $novaCacheReady == 1
    # Invalidate the previous record/index even after manual/overwrite installs.
    ClearErrors
    Delete "$novaCacheRoot\installer-state.json"
    Delete "$novaCacheRoot\current.blockmap"
    ${IfNot} ${FileExists} "$novaCacheRoot\installer-state.json"
    ${AndIfNot} ${FileExists} "$novaCacheRoot\current.blockmap"
      # Explicit overwrite; do not trust the earlier unchecked shell CopyFiles.
      System::Call 'kernel32::CopyFileW(w "${SOURCE}", w "$novaCacheRoot\installer.next.exe", i 0) i.r0'
      ${If} $0 != 0
        ${StdUtils.HashFile} $1 "SHA2-512" "${SOURCE}"
        ${StdUtils.HashFile} $2 "SHA2-512" "$novaCacheRoot\installer.next.exe"
        StrLen $3 $1
        ${If} $3 == 128
        ${AndIf} $1 == $2
          ${If} "${SOURCE}" == "$novaCacheRoot\installer.exe"
            # A user may run the cached installer itself. Its verified bytes
            # already are the baseline; replacing an executing EXE would fail.
            StrCpy $0 1
          ${Else}
            System::Call 'kernel32::MoveFileExW(w "$novaCacheRoot\installer.next.exe", w "$novaCacheRoot\installer.exe", i 9) i.r0'
          ${EndIf}
          ${If} $0 != 0
            ClearErrors
            FileOpen $4 "$novaCacheRoot\installer-state.next.json" w
            ${IfNot} ${Errors}
              FileWrite $4 '{"schemaVersion":1,"appId":"${APP_ID}","version":"${VERSION}","sha512":"$1"}'
              FileClose $4
              ${IfNot} ${Errors}
                System::Call 'kernel32::MoveFileExW(w "$novaCacheRoot\installer-state.next.json", w "$novaCacheRoot\installer-state.json", i 9) i.r0'
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Delete "$novaCacheRoot\installer.next.exe"
    Delete "$novaCacheRoot\installer-state.next.json"
  ${EndIf}
  !insertmacro novaCloseInstallerCache
  ClearErrors
!macroend