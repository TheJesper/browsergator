' Windows-only helper: run a Node launcher script with NO console window.
'
' Task Scheduler runs node.exe (a console app) which can flash a black window at
' logon even with the task's Hidden flag set. wscript.exe launches processes with
' a true hidden window, so routing through this wrapper removes the flicker.
'
' Usage (from Task Scheduler action):
'   Program : wscript.exe
'   Args    : "<repo>\scripts\hidden-launch.vbs" "<repo>\scripts\<launcher>.mjs" [extra args]
'
' Arg 0 = absolute path to the .mjs launcher. Args 1..n = passed through to node.

Option Explicit

Dim shell, fso, args, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set args = WScript.Arguments

If args.Count < 1 Then
  WScript.Quit 2
End If

' Resolve the node executable: prefer PATH, so nvm4w / fnm / winget all work.
Dim nodeCmd
nodeCmd = "node"

' Build a quoted command line: node "<launcher>" <passthrough args...>
Dim cmd
cmd = """" & nodeCmd & """"
For i = 0 To args.Count - 1
  cmd = cmd & " """ & args(i) & """"
Next

' 0 = hidden window, False = do not wait (fire and forget).
shell.Run cmd, 0, False
WScript.Quit 0
