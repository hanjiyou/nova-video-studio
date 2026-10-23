# Reject the destructive electron-builder override before its removal section.
!macro customUnInstall
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    SetErrorLevel 2
    Abort "User data deletion is disabled in this local test build."
  ${EndIf}
!macroend
