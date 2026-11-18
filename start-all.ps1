# OpenFuture 一键启动：账号服务(8090) + 桌面端(手机访问 8787)
# 用法：右键“使用 PowerShell 运行”，或在 PowerShell 里执行 .\start-all.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$java = 'F:\PROGRAM_files\ideaIU-2023.3.2.win\jbr\bin\java.exe'
$jar = Join-Path $root 'cloud\target\openfuture-cloud.jar'
$app = Join-Path $root 'node_modules\electron\dist\electron.exe'

function Test-Port($port) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', $port)
    $client.Close()
    return $true
  } catch { return $false }
}

if (Test-Port 8090) {
  Write-Host "[skip] 账号服务已在运行：http://127.0.0.1:8090/app.html"
} elseif (Test-Path $jar) {
  Start-Process -FilePath $java -ArgumentList '-jar', $jar -WorkingDirectory (Join-Path $root 'cloud') -WindowStyle Hidden
  Write-Host "[start] 账号服务启动中：http://127.0.0.1:8090/app.html（约 20 秒）"
} else {
  Write-Host "[warn] 没有找到 cloud\target\openfuture-cloud.jar，先运行 cloud\build.cmd"
}

if (Test-Port 8787) {
  Write-Host "[skip] 桌面端已在运行，手机访问：http://<电脑IP>:8787"
} else {
  Start-Process -FilePath $app -ArgumentList $root -WorkingDirectory $root
  Write-Host "[start] 桌面端已启动，等待窗口出现后到「设置 → 手机访问」看地址和配对码"
}

Write-Host ""
Write-Host "手机账户页：http://<电脑IP>:8090/app.html"
Write-Host "管理后台：  http://127.0.0.1:8090/admin.html  （令牌 dev-admin）"
Write-Host "手机端（APK）：设置 → 手机访问，扫码或输入 6 位配对码"
