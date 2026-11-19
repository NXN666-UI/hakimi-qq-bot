param([ValidateSet('Menu','Start','Stop','Restart','Status','Backup')][string]$Action='Menu')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$expectedExecutable=Join-Path $projectRoot 'runtime\node.exe'
$dataRoot=Join-Path $projectRoot 'data'
foreach ($folder in @('tmp','cache','backups')) { New-Item -ItemType Directory -Path (Join-Path $dataRoot $folder) -Force | Out-Null }
$env:TEMP=Join-Path $dataRoot 'tmp'; $env:TMP=$env:TEMP; $env:TMPDIR=$env:TEMP
$env:XDG_CACHE_HOME=Join-Path $dataRoot 'cache'
$env:NODE_COMPILE_CACHE=Join-Path $env:XDG_CACHE_HOME 'node'
$env:NODE_OPTIONS=''
function Port-Open([int]$Port) {
  $client=[Net.Sockets.TcpClient]::new()
  try { $operation=$client.ConnectAsync('127.0.0.1',$Port); return ($operation.Wait(800) -and $client.Connected) } catch { return $false } finally { $client.Dispose() }
}
function Main-Process {
  $lock=Join-Path $dataRoot 'app.lock'
  if (-not (Test-Path -LiteralPath $lock)) { return $null }
  $number=0
  if (-not [int]::TryParse((Get-Content -LiteralPath $lock -Raw).Trim(),[ref]$number) -or $number -le 0) { throw '进程锁格式有误，请保留文件排查。' }
  $item=Get-Process -Id $number -ErrorAction SilentlyContinue
  if (-not $item) { return $null }
  if ($item.Path -ne $expectedExecutable) { throw '进程锁指向其他程序，拒绝自动操作。' }
  return $item
}
function Show-Status {
  $running=Main-Process
  if ($running) {
    Write-Output "哈基米：运行中，PID $($running.Id)"
    $file=Join-Path $dataRoot 'runtime-status.json'
    if (Test-Path -LiteralPath $file) {
      $state=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
      if ($state.pid -eq $running.Id -and [Math]::Abs(($running.StartTime.ToUniversalTime()-[DateTimeOffset]::Parse($state.startedAt).UtcDateTime).TotalSeconds) -lt 5) {
        if ($state.connected) { Write-Output "QQ $($state.botQQ)：已校验身份，桥接已连接" } else { Write-Output 'QQ桥接：正在等待连接' }
        if ($state.paused) { Write-Output '聊天：已被主人暂停；在群里或私聊发送 /哈基米 恢复' }
      }
    }
  } else { Write-Output '哈基米：已关闭' }
  Write-Output '请按config.json中的onebot.wsUrl检查桥接端口。'
  Write-Output '端口监听不等于模型可用；本状态检查不调用模型。'
}
function Start-Hakimi {
  $running=Main-Process
  if ($running) { Write-Output '哈基米已经运行，无需重复启动。'; Show-Status; return }
  Push-Location $projectRoot
  try {
    & $expectedExecutable 'src/main.mjs' '--check'
    if ($LASTEXITCODE -ne 0) { throw '配置检查未通过，没有启动。' }
    $bridgeConfig=Get-Content -LiteralPath (Join-Path $projectRoot 'config.json') -Raw | ConvertFrom-Json
    $bridgePort=([Uri]$bridgeConfig.onebot.wsUrl).Port
    if(-not (Port-Open $bridgePort)){throw 'OneBot入口未就绪，请先登录机器人账号并启动自己的桥接；不会替你安装或重启公共服务。'}
    & $expectedExecutable 'scripts/probe.mjs' 'qq'
    if ($LASTEXITCODE -ne 0) { throw '小号或白名单群校验未通过，没有启动聊天。' }
    & (Join-Path $PSScriptRoot 'start-bot.ps1') 
    for($i=0;$i -lt 20;$i++) {
      Start-Sleep -Milliseconds 300
      $stateFile=Join-Path $dataRoot 'runtime-status.json'
      if(Test-Path -LiteralPath $stateFile) { $state=Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json; $p=Main-Process; if($p -and $state.pid -eq $p.Id -and $state.connected -and -not $state.stopped){break} }
    }
    if (-not (Main-Process)) { throw '哈基米启动后退出，请查看 logs 中最新的 .err.log。' }
    Show-Status
    Write-Output '可以关闭此菜单窗口，哈基米继续在后台运行。启动不会发送招呼或自动调用模型。'
  } finally { Pop-Location }
}
function Backup-Hakimi {
  $destination=Join-Path $dataRoot ('backups\manual-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.zip')
  $relative=@('config.json','.env','persona.md','data\memory.json','data\private-memory.json','data\chat-control.json','data\ai-peer-usage.json','data\usage.json','data\media-usage.json','data\search-usage.json')
  $files=@($relative | ForEach-Object { $file=Join-Path $projectRoot $_; if(Test-Path -LiteralPath $file){Get-Item -LiteralPath $file} })
  $memorySnapshot=$null
  if(Test-Path -LiteralPath (Join-Path $dataRoot 'memory\memories.sqlite')) {
    $memorySnapshot=Join-Path $dataRoot ('tmp\memory-backup-'+[Guid]::NewGuid().ToString('N')+'.sqlite')
    & $expectedExecutable (Join-Path $PSScriptRoot 'snapshot-memory.mjs') $memorySnapshot
    if($LASTEXITCODE -ne 0){throw '记忆快照未完成，没有打包不一致的数据库。'}
    $files+=Get-Item -LiteralPath $memorySnapshot
  }
  $files+=@(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'assets\stickers') -Recurse -File | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip=[IO.Compression.ZipFile]::Open($destination,[IO.Compression.ZipArchiveMode]::Create)
  try { foreach($file in $files) { $name=if($file.FullName -eq $memorySnapshot){'data/memory/memories.sqlite'}else{$file.FullName.Substring($projectRoot.Length+1).Replace('\','/')}; [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file.FullName,$name) | Out-Null } }
  finally { $zip.Dispose(); if($memorySnapshot -and (Test-Path -LiteralPath $memorySnapshot)){Remove-Item -LiteralPath $memorySnapshot} }
  Write-Output "已备份到 $destination"
  Write-Output '备份包含Key，仅留在本机。未备份QQ登录态、公共桥接数据库和图片缓存。完整一致的备份请先关闭哈基米再执行。'
}
function Invoke-Action([string]$Choice) {
  switch($Choice) {
    Start { Start-Hakimi }
    Stop { & (Join-Path $PSScriptRoot 'stop-hakimi.ps1') }
    Restart { & (Join-Path $PSScriptRoot 'stop-hakimi.ps1'); Start-Hakimi }
    Status { Show-Status }
    Backup { Backup-Hakimi }
  }
}
if($Action -ne 'Menu') { try { Invoke-Action $Action } catch { Write-Output "未完成：$($_.Exception.Message)"; exit 1 }; exit 0 }
while($true) {
  Write-Host "`n========== 哈基米控制台 =========="
  Write-Host '1 启动    2 关闭    3 重启    4 查看状态'
  Write-Host '5 编辑人设    6 编辑配置    7 打开操作手册'
  Write-Host '8 打开日志文件夹    9 备份配置和记忆    10 表情库说明'
  Write-Host '11 打开可视化设置网页    12 查看长期记忆    0 退出菜单'
  $choice=Read-Host '输入数字后按回车'
  try {
    switch($choice) {
      '1' { Invoke-Action Start }
      '2' { Invoke-Action Stop }
      '3' { Invoke-Action Restart }
      '4' { Invoke-Action Status }
      '5' { Start-Process notepad.exe -ArgumentList ('"'+(Join-Path $projectRoot 'persona.md')+'"') }
      '6' { Start-Process notepad.exe -ArgumentList ('"'+(Join-Path $projectRoot 'config.json')+'"') }
      '7' { Start-Process -FilePath (Join-Path $projectRoot 'docs\操作手册.html') }
      '8' { Invoke-Item -LiteralPath (Join-Path $projectRoot 'logs') }
      '9' { Invoke-Action Backup }
      '10' { Start-Process -FilePath (Join-Path $projectRoot 'assets\stickers\README.md') }
      '11' { & (Join-Path $PSScriptRoot 'open-settings.ps1') }
      '12' { & (Join-Path $PSScriptRoot 'open-settings.ps1') -Section memory }
      '0' { exit 0 }
      default { Write-Output '请输入0到12。' }
    }
  } catch { Write-Output "未完成：$($_.Exception.Message)" }
}
