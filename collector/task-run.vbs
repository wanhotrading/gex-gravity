Option Explicit
Dim taskShell, taskFiles, taskFolder, taskProject, taskNode, taskScript, taskExit
If WScript.Arguments.Count <> 1 Then WScript.Quit 64
Set taskShell = CreateObject("WScript.Shell")
Set taskFiles = CreateObject("Scripting.FileSystemObject")
taskNode = WScript.Arguments(0)
If LCase(taskFiles.GetFileName(taskNode)) <> "node.exe" Then WScript.Quit 64
If Not taskFiles.FileExists(taskNode) Then WScript.Quit 66
taskFolder = taskFiles.GetParentFolderName(WScript.ScriptFullName)
taskProject = taskFiles.GetParentFolderName(taskFolder)
taskScript = taskFiles.BuildPath(taskFolder, "run.mjs")
If Not taskFiles.FileExists(taskScript) Then WScript.Quit 66
taskShell.CurrentDirectory = taskProject
' GUI script host + window style 0 avoids creating the initial PowerShell console.
' Wait for Node so Task Scheduler overlap protection and exit codes still work.
taskExit = taskShell.Run(Chr(34) & taskNode & Chr(34) & " " & Chr(34) & taskScript & Chr(34), 0, True)
WScript.Quit taskExit
