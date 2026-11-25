$ErrorActionPreference='Stop'
$taskName='GEX Gravity - local market collector'
$taskProject=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskRuntime=[IO.Path]::GetFullPath((Join-Path $taskProject '../gex-gravity-collector'))
$taskConfigPath=Join-Path $taskRuntime 'config.json'
$taskConfig=Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json
if($taskConfig.browserApproved -ne $true -or !(Test-Path -LiteralPath (Join-Path $taskRuntime 'site-access.dpapi'))){throw 'Finish the approved local setup first.'}
$taskUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
# Keep runtime credentials and the signed-in browser profile within this account.
$taskAcl=Get-Acl -LiteralPath $taskRuntime
$taskAcl.SetAccessRuleProtection($true,$false)
$taskAcl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($taskSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
$taskAcl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $taskRuntime -AclObject $taskAcl
$taskNode=(Get-Command node.exe).Source
$taskScriptHost=Join-Path $env:SystemRoot 'System32/wscript.exe'
if(!(Test-Path -LiteralPath $taskScriptHost)){throw 'Windows script host is unavailable; retain the existing working collector task.'}
$taskAction=New-ScheduledTaskAction -Execute $taskScriptHost -Argument ('//B //Nologo "'+(Join-Path $PSScriptRoot 'task-run.vbs')+'" "'+$taskNode+'"') -WorkingDirectory $taskProject
$taskMinute=New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)
$taskLogon=New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskSettings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 6)
$taskPrincipal=New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$taskDescription='Ordinary Node.js collector for owner-private GEX Gravity. Five-minute Futu and MenthorQ slots during the nominal futures week, no AI/model calls. Requires this Windows account signed in and the computer awake. MenthorQ uses the approved dedicated loopback Chrome profile.'
$taskExisting=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($taskExisting -and $taskExisting.Description -ne $taskDescription){throw 'A different task already uses this name; it was not replaced.'}
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger @($taskMinute,$taskLogon) -Settings $taskSettings -Principal $taskPrincipal -Description $taskDescription -Force | Out-Null
$taskConfig | Add-Member -NotePropertyName nodeExecutable -NotePropertyValue $taskNode -Force
$taskConfig | Add-Member -NotePropertyName taskInstalled -NotePropertyValue $true -Force
[IO.File]::WriteAllText($taskConfigPath,($taskConfig | ConvertTo-Json))
$taskInstalled=Get-ScheduledTask -TaskName $taskName
if($taskInstalled.State -eq 'Disabled' -or [int]$taskInstalled.Settings.MultipleInstances -ne 2){throw 'Task registration verification failed.'}
Write-Output ('Installed: '+$taskName+'; one-minute heartbeat; five-minute provider slots; interactive Windows account; hidden background action.')
