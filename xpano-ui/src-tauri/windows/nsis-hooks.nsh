!macro XPANO_REMOVE_DIR DIR
  IfFileExists "${DIR}\*.*" 0 +2
    RMDir /r "${DIR}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrLen $0 "$INSTDIR"
  IntOp $0 $0 - 5
  StrCpy $1 "$INSTDIR" "" $0
  StrCmp $1 "xPano" +2 0
    StrCpy $INSTDIR "$INSTDIR\xPano"
  ; Tauri calls SetOutPath before this hook. If the hook changes $INSTDIR,
  ; refresh the NSIS output directory or File /oname writes to the old path
  ; while CreateDirectory uses the new one, leaving empty resource folders.
  SetOutPath "$INSTDIR"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current

  ; Tauri app data and WebView runtime data. Keep project/output folders intact.
  !insertmacro XPANO_REMOVE_DIR "$APPDATA\com.xpano.app"
  !insertmacro XPANO_REMOVE_DIR "$LOCALAPPDATA\com.xpano.app"
  !insertmacro XPANO_REMOVE_DIR "$APPDATA\xPano"
  !insertmacro XPANO_REMOVE_DIR "$LOCALAPPDATA\xPano"
  !insertmacro XPANO_REMOVE_DIR "$APPDATA\xpano"
  !insertmacro XPANO_REMOVE_DIR "$LOCALAPPDATA\xpano"
  !insertmacro XPANO_REMOVE_DIR "$APPDATA\xpano-ui"
  !insertmacro XPANO_REMOVE_DIR "$LOCALAPPDATA\xpano-ui"
!macroend
