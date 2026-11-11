Option Explicit

Dim shell, fso, root, node, vite, electron, logDir, buildLog, quote, result, userProfile
Dim debugLog, launchResult
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = "D:\OpenFuture"
userProfile = shell.ExpandEnvironmentStrings("%USERPROFILE%")
node = userProfile & "\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
vite = root & "\node_modules\electron-vite\bin\electron-vite.js"
electron = root & "\node_modules\electron\dist\electron.exe"
logDir = root & "\.scratch"
buildLog = logDir & "\launcher-build.log"

If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
Set debugLog = fso.CreateTextFile(logDir & "\launcher-debug.log", True)
debugLog.WriteLine "start=" & Now
debugLog.WriteLine "node=" & node
debugLog.WriteLine "pwd=[" & shell.ExpandEnvironmentStrings("%PWD%") & "]"
debugLog.WriteLine "electronRunAsNode=[" & shell.ExpandEnvironmentStrings("%ELECTRON_RUN_AS_NODE%") & "]"

If Not fso.FileExists(node) Then
  debugLog.WriteLine "missing node"
  debugLog.Close
  MsgBox "OpenFuture launcher cannot find Node 24:" & vbCrLf & node, 16, "OpenFuture"
  WScript.Quit 1
End If
If Not fso.FileExists(vite) Then
  debugLog.WriteLine "missing vite"
  debugLog.Close
  MsgBox "OpenFuture launcher cannot find electron-vite:" & vbCrLf & vite, 16, "OpenFuture"
  WScript.Quit 1
End If
If Not fso.FileExists(electron) Then
  debugLog.WriteLine "missing electron"
  debugLog.Close
  MsgBox "OpenFuture launcher cannot find Electron:" & vbCrLf & electron, 16, "OpenFuture"
  WScript.Quit 1
End If

shell.CurrentDirectory = root
quote = Chr(34)

On Error Resume Next
shell.Environment("PROCESS").Remove("PWD")
shell.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")
shell.Environment("PROCESS").Remove("OPENFUTURE_USER_DATA")
If Err.Number <> 0 Then debugLog.WriteLine "env remove error=" & Err.Description
Err.Clear
On Error GoTo 0

debugLog.WriteLine "after remove pwd=[" & shell.ExpandEnvironmentStrings("%PWD%") & "]"
debugLog.WriteLine "after remove electronRunAsNode=[" & shell.ExpandEnvironmentStrings("%ELECTRON_RUN_AS_NODE%") & "]"

' Build the current source before every launch so the shortcut never opens an
' outdated renderer/main bundle. The build window stays hidden.
result = shell.Run(quote & node & quote & " " & quote & vite & quote & " build", 0, True)
debugLog.WriteLine "build result=" & result

If result <> 0 Then
  debugLog.WriteLine "build failed"
  debugLog.Close
  MsgBox "OpenFuture build failed (" & result & ")." & vbCrLf & root, 16, "OpenFuture"
  WScript.Quit result
End If

' Launch detached so closing this script does not close OpenFuture.
launchResult = shell.Run(quote & electron & quote & " . --remote-debugging-port=9257", 1, False)
debugLog.WriteLine "launch result=" & launchResult
debugLog.WriteLine "end=" & Now
debugLog.Close
