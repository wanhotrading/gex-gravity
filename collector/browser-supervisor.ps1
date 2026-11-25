param([Parameter(Mandatory=$true)][string]$Runtime)
$ErrorActionPreference='Stop'
$taskProfile=[IO.Path]::GetFullPath((Join-Path $Runtime 'browser-profile'))
$taskListeners=@(Get-NetTCPConnection -State Listen -LocalPort 9337 -ErrorAction SilentlyContinue)
if($taskListeners.Count -eq 0){
  $taskChrome='C:\Program Files\Google\Chrome\Application\chrome.exe'
  if(!(Test-Path -LiteralPath $taskChrome)){throw 'MQ_BROWSER_UNAVAILABLE'}
  Start-Process -FilePath $taskChrome -WindowStyle Hidden -ArgumentList @(('--user-data-dir="'+$taskProfile+'"'),'--remote-debugging-port=9337','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--new-window','about:blank')
  for($taskAttempt=0;$taskAttempt -lt 30;$taskAttempt++){
    Start-Sleep -Milliseconds 300
    $taskListeners=@(Get-NetTCPConnection -State Listen -LocalPort 9337 -ErrorAction SilentlyContinue)
    if($taskListeners.Count -gt 0){break}
  }
}
if($taskListeners.Count -eq 0){throw 'MQ_BROWSER_UNAVAILABLE'}
foreach($taskListener in $taskListeners){
  if($taskListener.LocalAddress -ne '127.0.0.1'){throw 'MQ_BROWSER_BINDING_REJECTED'}
  $taskProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskListener.OwningProcess)
  $taskCommand=([string]$taskProcess.CommandLine).Replace('"','').Replace('/','\')
  $taskProfilePattern='(?i)--user-data-dir='+[regex]::Escape($taskProfile)+'(?=\s|$)'
  if($taskProcess.Name -ne 'chrome.exe' -or $taskCommand -notmatch '--remote-debugging-port=9337(?=\s|$)' -or $taskCommand -notmatch $taskProfilePattern){throw 'MQ_BROWSER_PROFILE_REJECTED'}
}
Write-Output 'Dedicated browser verified on 127.0.0.1:9337.'
