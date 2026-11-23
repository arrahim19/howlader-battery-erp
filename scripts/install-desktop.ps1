$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$app = $shell.CreateShortcut((Join-Path $desktop 'Howlader Battery House.lnk'))
$app.TargetPath = $powershell
$app.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $projectRoot 'scripts/open-desktop.ps1') + '"'
$app.WorkingDirectory = $projectRoot
$app.Description = 'Howlader Battery House desktop workspace and PC sync server'
$app.Save()
$server = $shell.CreateShortcut((Join-Path $startup 'Howlader ERP Server.lnk'))
$server.TargetPath = $powershell
$server.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $projectRoot 'scripts/start-server-hidden.ps1') + '"'
$server.WorkingDirectory = $projectRoot
$server.Description = 'Start the local ERP database and backup/sync server at Windows sign-in'
$server.Save()
Write-Output 'Desktop shortcut and current-user sign-in startup installed.'
