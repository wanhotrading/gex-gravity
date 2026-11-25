$ErrorActionPreference='Stop'
$taskProject=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskRuntime=[IO.Path]::GetFullPath((Join-Path $taskProject '../gex-gravity-collector'))
$taskConfig=Get-Content -LiteralPath (Join-Path $taskRuntime 'config.json') -Raw | ConvertFrom-Json
Set-Location -LiteralPath $taskProject
& $taskConfig.nodeExecutable (Join-Path $PSScriptRoot 'run.mjs')
exit $LASTEXITCODE
