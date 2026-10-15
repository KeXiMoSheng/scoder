; 用户手动选择安装路径后，自动在所选目录下追加 scoder 子目录
; 例如：选择 D:\ -> 最终安装到 D:\scoder
!define DIR_NAME "scoder"

Function .onVerifyInstDir
  StrLen $0 "${DIR_NAME}"
  StrCpy $1 "$INSTDIR" "" -$0
  StrCmp $1 "${DIR_NAME}" +2 0
    StrCpy $INSTDIR "$INSTDIR\${DIR_NAME}"
FunctionEnd
