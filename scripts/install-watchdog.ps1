$Action = New-ScheduledTaskAction -Execute "C:\Program Files\Git\bin\bash.exe" -Argument "-c '/c/Users/emily/Documents/Github/orca/scripts/watchdog.sh'"
$Trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 2) -Once -At (Get-Date)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "OrcaWatchdog" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Monitors Orca and PM2 health, auto-recovers on failure" -Force

Write-Host "Scheduled task 'OrcaWatchdog' registered successfully (runs every 2 minutes)."
