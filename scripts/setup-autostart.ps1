# setup-autostart.ps1 — Create a Windows Task Scheduler task to run restart.sh on user logon

$ProjectDir = (Resolve-Path "$PSScriptRoot\..").Path
$UnixPath = $ProjectDir.Replace("\", "/")
if ($UnixPath -match "^([A-Za-z]):(.*)") {
    $UnixPath = "/" + $Matches[1].ToLower() + $Matches[2]
}

$Action = New-ScheduledTaskAction -Execute "C:\Program Files\Git\bin\bash.exe" -Argument "-c '$UnixPath/scripts/restart.sh'"
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Trigger.Delay = "PT30S"
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "OrcaAutostart" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Starts Orca and Inngest on user logon via restart.sh" -Force

Write-Host "Scheduled task 'OrcaAutostart' registered successfully (runs at logon with 30s delay)."
