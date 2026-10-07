; limecore#52 - desktop updates failed with "Failed to uninstall old
; application files. Please try running the installer again.: 2".
;
; Every installer first runs the OLD version's uninstaller, always in update
; mode. In update mode that uninstaller moves each installed file into
; %TEMP%\nsXXXX.tmp\old-install\ before deleting anything, and aborts (exit 2)
; if any single move fails. Builds up to 1.16 shipped ~6,000 Android build
; files from the Capacitor plugins in resources\app.asar.unpacked, nested so
; deep that their moved paths pass Windows' 260-character limit, so the move
; always failed. A longer Windows username makes the paths longer still.
;
; Packaging no longer ships those files (package.json `build.files`), but the
; installs already out there still have them, and their own uninstaller is the
; one that runs. So this installer fixes it from the outside:
;
;   customInit             delete the old install's app.asar.unpacked before the
;                          old uninstaller runs. `rd` with a \\?\ path handles
;                          long paths; NSIS's own file calls do not. Nothing in
;                          that folder is ever loaded by the desktop app.
;   customUnInstallCheck   if the old uninstaller still fails, on any file it
;                          cannot move (one another program holds open, say),
;                          install over the old files instead of stopping. The
;                          stop strands the user on the old version until they
;                          uninstall by hand; installing over replaces every
;                          file the new version ships.

!macro customInit
  ; initMultiUser has run, so $INSTDIR is the existing install, if any.
  ${if} ${FileExists} "$INSTDIR\resources\app.asar.unpacked\*.*"
    nsExec::Exec '"$SYSDIR\cmd.exe" /c rd /s /q "\\?\$INSTDIR\resources\app.asar.unpacked"'
    Pop $0
  ${endIf}
!macroend

!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint "The previous version's uninstaller returned $R0. Installing over it."
  ${endIf}
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro customUnInstallCheck
!macroend
