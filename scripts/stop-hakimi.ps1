$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$lockFile = Join-Path $projectRoot 'data\app.lock'
$processFile = Join-Path $projectRoot 'data\hakimi-process.json'
$statusFile = Join-Path $projectRoot 'data\runtime-status.json'
if (-not (Test-Path -LiteralPath $lockFile)) { Write-Output '哈基米已关闭。QQ 和公共 SnowLuma 保持原状。'; return }
$hakimiPid = [int](Get-Content -LiteralPath $lockFile -Raw)
$running = Get-Process -Id $hakimiPid -ErrorAction SilentlyContinue
if (-not $running) { Write-Output '哈基米已关闭；旧锁会在下次启动时检查并回收。'; return }
$expectedExecutable = [IO.Path]::GetFullPath((Join-Path $projectRoot 'runtime\node.exe'))
if (-not $running.Path -or [IO.Path]::GetFullPath($running.Path) -ne $expectedExecutable) { throw '进程路径不匹配，拒绝停止，未处理其他进程。' }
$record = $null
if (Test-Path -LiteralPath $statusFile) {
  $candidate = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
  if ($candidate.pid -eq $hakimiPid) { $record = $candidate }
}
if (-not $record -and (Test-Path -LiteralPath $processFile)) { $record = Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json }
if (-not $record -or [int]$record.pid -ne $hakimiPid) { throw '缺少匹配的进程身份记录，拒绝自动停止。' }
$recordedStart = [DateTimeOffset]::Parse($record.StartedAt)
if ([Math]::Abs(($running.StartTime.ToUniversalTime() - $recordedStart.UtcDateTime).TotalSeconds) -gt 5) { throw '进程启动时间不匹配，可能是旧记录，拒绝停止。' }
if ($record.version -eq 1) {
  $requestFile = Join-Path $projectRoot 'data\stop-request.json'
  $temporary = "$requestFile.tmp"
  [IO.File]::WriteAllText($temporary, (@{pid=$hakimiPid;startedAt=$record.startedAt} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $requestFile -Force
  for ($i=0; $i -lt 30; $i++) { if (-not (Get-Process -Id $hakimiPid -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 200 }
}
$remaining = Get-Process -Id $hakimiPid -ErrorAction SilentlyContinue
if ($remaining) {
  if ($remaining.Path -ne $expectedExecutable -or $remaining.StartTime -ne $running.StartTime) { throw '等待期间进程身份变化，未强制关闭。' }
  Stop-Process -Id $hakimiPid -ErrorAction Stop
}
Write-Output '哈基米已关闭。没有停止 QQ、公共 SnowLuma、DSH 或其他机器人。'
