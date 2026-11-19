$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$env:TEMP=Join-Path $projectRoot 'data\tmp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP
$env:NODE_COMPILE_CACHE=Join-Path $projectRoot 'data\cache\node';$env:NODE_OPTIONS=''
New-Item -ItemType Directory -Path $env:TEMP,$env:NODE_COMPILE_CACHE,(Join-Path $projectRoot 'logs') -Force|Out-Null
$node=Join-Path $projectRoot 'runtime\node.exe'
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$p=Start-Process -FilePath $node -ArgumentList @('src/main.mjs') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot "logs\bot-$stamp.out.log") -RedirectStandardError (Join-Path $projectRoot "logs\bot-$stamp.err.log") -PassThru
Write-Output ("已启动聊天进程，PID "+$p.Id)
