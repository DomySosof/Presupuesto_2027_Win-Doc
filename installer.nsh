!macro customInstall
  ; Crear directorio de datos en AppData
  ExecWait '"$SYSDIR\cmd.exe" /c mkdir "$APPDATA\Presupuesto\data" 2>nul'
!macroend

!macro customUnInstall
  ; Opcional: limpiar datos al desinstalar (comentado para preservar datos del usuario)
  ; RMDir /r "$APPDATA\Presupuesto"
!macroend