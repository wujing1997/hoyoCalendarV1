; HoYoCalendar NSIS hooks (electron-builder `nsis.include`).
;
; Builds up to 3.0.11 used a versioned product name, so every release installed a
; differently named executable (HoYoCalendarV3.0.x.exe) and relied on the previous
; uninstaller to remove it. When that uninstaller is missing the old files stayed
; behind. From 3.0.12 the executable is always HoYoCalendar.exe; these hooks clean
; up whatever the versioned builds left in the install directory.

!macro customInit
  ; The built-in running-app check only knows the new executable name, so close
  ; versioned builds (often running in the tray) before their files are replaced.
  ; Match by install path: an image-name wildcard would also match this installer
  ; (HoYoCalendarV3.0.x-setup.exe) and kill it. Win32_Process is used because the
  ; 32-bit PowerShell started from NSIS cannot read Get-Process paths of 64-bit apps.
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -like '$INSTDIR\HoYoCalendarV*.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }; Start-Sleep -Milliseconds 800"`
  Pop $0

  ; The installer runs the uninstaller recorded in the registry first and aborts
  ; if it cannot. Some machines still record a long-gone versioned uninstaller
  ; (e.g. "Uninstall HoYoCalendarV3.0.7.exe"); drop that stale command so the
  ; install can proceed, and let customInstall remove the leftover files.
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCpy $1 $0 1
  StrCmp $1 '"' 0 hoyo_uninstall_checked
  StrCpy $1 $0 "" 1
  StrCpy $2 0
  hoyo_find_quote:
    StrCpy $3 $1 1 $2
    StrCmp $3 '"' hoyo_quote_found
    StrCmp $3 "" hoyo_uninstall_checked
    IntOp $2 $2 + 1
    Goto hoyo_find_quote
  hoyo_quote_found:
    StrCpy $1 $1 $2
    IfFileExists "$1" hoyo_uninstall_checked
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
  hoyo_uninstall_checked:
!macroend

!macro customInstall
  Delete "$INSTDIR\HoYoCalendarV*.exe"
  Delete "$INSTDIR\Uninstall HoYoCalendarV*.exe"

  ; Existing shortcuts may still point at a versioned executable; repoint only the
  ; ones the user kept, never recreate ones they deleted.
  ${If} ${FileExists} "$DESKTOP\HoYoCalendar.lnk"
    CreateShortCut "$DESKTOP\HoYoCalendar.lnk" "$INSTDIR\HoYoCalendar.exe"
  ${EndIf}
  ${If} ${FileExists} "$SMPROGRAMS\HoYoCalendar.lnk"
    CreateShortCut "$SMPROGRAMS\HoYoCalendar.lnk" "$INSTDIR\HoYoCalendar.exe"
  ${EndIf}
!macroend
