; "Open in Myko" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInMyko" "" "Open in Myko"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInMyko" "Icon" '"$INSTDIR\myko.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInMyko" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInMyko\command" "" '"$INSTDIR\myko.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInMyko" "" "Open in Myko"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInMyko" "Icon" '"$INSTDIR\myko.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInMyko" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInMyko\command" "" '"$INSTDIR\myko.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInMyko" "" "Open in Myko"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInMyko" "Icon" '"$INSTDIR\myko.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInMyko" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInMyko\command" "" '"$INSTDIR\myko.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInMyko"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInMyko"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInMyko"
!macroend
