!include "${PROJECT_DIR}\desktop\installer\data-retention.nsh"
!include "${PROJECT_DIR}\desktop\installer\update-cache.nsh"
!macro customHeader
  # Keep the package/app/data identity, replace only the NSIS cache target.
  !undef APP_INSTALLER_STORE_FILE
  !define APP_INSTALLER_STORE_FILE "${APP_ID}-updater\installer.next.exe"
!macroend
!macro customInit
  SetShellVarContext current
  !insertmacro novaPrepareInstallerCache "$LOCALAPPDATA\${APP_ID}-updater"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
!macroend
!macro customInstall
  !insertmacro novaPublishInstallerCache "$EXEPATH"
!macroend
!ifndef BUILD_UNINSTALLER
Function .onGUIEnd
  !insertmacro novaCloseInstallerCache
FunctionEnd
Function .onInstFailed
  !insertmacro novaCloseInstallerCache
FunctionEnd
!endif