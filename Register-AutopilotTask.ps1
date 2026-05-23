#requires -Version 5.1
<#
.SYNOPSIS
    Install / remove a Windows Scheduled Task that auto-starts the context autopilot at logon.

.DESCRIPTION
    Opt-in "always-on" arming. Registers a task that launches the autopilot watcher at logon,
    pointed at a single project directory.

    IMPORTANT — window targeting caveat:
      The watcher injects "/compact" and "/clear" as keystrokes into ONE window it captures at
      startup. At logon there is no Claude terminal in focus yet, so a logon-started watcher cannot
      know which window to type into. Two ways to make scheduled/auto-start mode actually work:

        1. (Recommended) Don't auto-start. Arm it by hand in the session you want it to guard:
               powershell -File .\claude-context-autopilot.ps1
           then click your Claude terminal during the countdown. This is the reliable path.

        2. If you insist on logon auto-start, pass a stable -TargetHandle via -ExtraArgs once you
           know the Claude window handle, OR accept that the watcher will (re)capture whatever is
           foreground when it starts. Use -DryRun first.

    This installer exists to mirror Register-AutoResumeTask.ps1, but manual arming is the
    primary supported workflow for the autopilot. Read the README before relying on logon mode.

.PARAMETER Project
    Project directory the watcher should guard. Required for -Install.

.PARAMETER Install
    Create the scheduled task.

.PARAMETER Uninstall
    Remove the scheduled task.

.PARAMETER RunNow
    Also start the watcher immediately after installing.

.PARAMETER ExtraArgs
    Extra arguments appended verbatim to the watcher invocation (e.g. '-DryRun' or '-TargetHandle 123456').

.PARAMETER TaskName
    Scheduled task name. Default "ClaudeContextAutopilot".

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Register-AutopilotTask.ps1 -Install -Project C:\Users\Win\my-app -ExtraArgs '-DryRun'

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Register-AutopilotTask.ps1 -Uninstall
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(ParameterSetName = 'Install')][switch]$Install,
    [Parameter(ParameterSetName = 'Install')][string]$Project,
    [Parameter(ParameterSetName = 'Install')][switch]$RunNow,
    [Parameter(ParameterSetName = 'Install')][string]$ExtraArgs = '',
    [Parameter(ParameterSetName = 'Uninstall')][switch]$Uninstall,
    [string]$TaskName = 'ClaudeContextAutopilot'
)

$ErrorActionPreference = 'Stop'
$watcher = Join-Path $PSScriptRoot 'claude-context-autopilot.ps1'

if (-not $Install -and -not $Uninstall) {
    throw "Nothing to do. Pass -Install (with -Project <dir> [-RunNow] [-ExtraArgs '...']) or -Uninstall. Run 'Get-Help .\Register-AutopilotTask.ps1 -Examples' for usage."
}

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
    } else {
        Write-Host "No scheduled task named '$TaskName' found." -ForegroundColor Yellow
    }
    return
}

# --- Install path ---
if (-not $Project) { throw "Specify -Project <dir> when installing." }
if (-not (Test-Path $Project)) { throw "Project directory not found: $Project" }
if (-not (Test-Path $watcher)) { throw "Watcher script not found next to this installer: $watcher" }

$ps = (Get-Command powershell.exe).Source
$argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Project "{1}"' -f $watcher, $Project
if ($ExtraArgs.Trim().Length -gt 0) { $argLine = '{0} {1}' -f $argLine, $ExtraArgs.Trim() }

$action  = New-ScheduledTaskAction -Execute $ps -Argument $argLine
$trigger = New-ScheduledTaskTrigger -AtLogOn
# Run as the current user, only when logged on (keystroke injection needs the interactive session).
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "  Watches project: $Project" -ForegroundColor Gray
Write-Host "  Runs the watcher at each logon. Remove with: -Uninstall" -ForegroundColor Gray
Write-Host "  NOTE: logon-start cannot reliably target your Claude window. Manual arming is preferred." -ForegroundColor Yellow

if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started the watcher now." -ForegroundColor Green
}
