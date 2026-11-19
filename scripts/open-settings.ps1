param([switch]$NoBrowser,[ValidateSet('overview','memory')][string]$Section='overview')
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$webData=Join-Path $projectRoot 'data'
$env:TEMP=Join-Path $webData 'tmp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP
$env:NODE_COMPILE_CACHE=Join-Path $webData 'cache\node'
$env:NODE_OPTIONS=''
New-Item -ItemType Directory -Path $env:TEMP,$env:NODE_COMPILE_CACHE,(Join-Path $projectRoot 'logs') -Force | Out-Null
$node=Join-Path $projectRoot 'runtime\node.exe'
$statusPath=Join-Path $webData 'web-ui-status.json'
function Web-Ready {
  try {
    $s=Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    $p=Get-Process -Id $s.pid -ErrorAction Stop
    if($p.Path -ne $node -or [Math]::Abs(($p.StartTime.ToUniversalTime()-[DateTimeOffset]::Parse($s.startedAt).UtcDateTime).TotalSeconds) -gt 5){return $false}
    $r=Invoke-WebRequest -Uri 'http://127.0.0.1:17863/' -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200 -and $r.Content.Contains('HAKIMI / SETTINGS'))
  } catch {return $false}
}
if(-not (Web-Ready)) {
  $tcp=[Net.Sockets.TcpClient]::new()
  try {$occupied=$tcp.ConnectAsync('127.0.0.1',17863).Wait(700)}catch{$occupied=$false}finally{$tcp.Dispose()}
  if($occupied){throw '17863端口由其他或未核实的程序占用，请检查，未修改它。'}
  Start-Process -FilePath $node -ArgumentList @('src/web-ui.mjs') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot 'logs\web-ui.out.log') -RedirectStandardError (Join-Path $projectRoot 'logs\web-ui.err.log') | Out-Null
  for($i=0;$i -lt 20;$i++){Start-Sleep -Milliseconds 300;if(Web-Ready){break}}
  if(-not (Web-Ready)){throw '界面未能启动，请检查logs/web-ui.err.log'}
}
$settingsUrl='http://127.0.0.1:17863/#'+$Section
Write-Output ('设置界面：'+$settingsUrl)
if(-not $NoBrowser){
  $browser=@('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe','C:\Program Files\Microsoft\Edge\Application\msedge.exe','C:\Program Files\Google\Chrome\Application\chrome.exe')|Where-Object {Test-Path -LiteralPath $_}|Select-Object -First 1
  if($browser){
    $profile=Join-Path $webData 'web-profile'
    Start-Process -FilePath $browser -ArgumentList @(('--app='+$settingsUrl),('--user-data-dir="'+$profile+'"'),'--no-first-run')
  }else{Write-Output '请用浏览器打开上方地址。'}
}
