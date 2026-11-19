param([string]$NodePath)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not $NodePath){$cmd=Get-Command node.exe -ErrorAction SilentlyContinue;if($cmd){$NodePath=$cmd.Source}}
if(-not $NodePath){throw '请安装官方Node.js 24或更高版本，或用-NodePath指定便携node.exe'}
$nodeSource=(Resolve-Path -LiteralPath $NodePath).Path
$version=& $nodeSource -p 'process.versions.node';if([int]($version.Split('.')[0])-lt 24){throw '需要Node.js 24或更高版本'}
New-Item -ItemType Directory -Path (Join-Path $root 'runtime'),(Join-Path $root 'data\tmp') -Force|Out-Null
$target=Join-Path $root 'runtime\node.exe'
if($nodeSource -ne $target -and -not (Test-Path -LiteralPath $target)){Copy-Item -LiteralPath $nodeSource -Destination $target}
foreach($pair in @(@('config.example.json','config.json'),@('.env.example','.env'),@('persona.example.md','persona.md'))){$out=Join-Path $root $pair[1];if(-not(Test-Path -LiteralPath $out)){Copy-Item -LiteralPath (Join-Path $root $pair[0]) -Destination $out}}
Write-Output '已初始化本项目本地文件。请填写config.json、.env及自己的persona.md；它们默认不进入Git。'
