#requires -Version 5.1
<#
.SYNOPSIS
    External, token-free context autopilot for an interactive Claude Code session.

.DESCRIPTION
    Watches the ACTIVE session's transcript on disk (never calls the API, so it costs
    zero tokens) and computes "context used %" the same way the in-app meter does:
        used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
        pct  = used / effective_window     (effective_window = autoCompactWindow from settings.json)

    Two automatic actions, sent as keystrokes to the Claude terminal window you point it at:
      * At >= CompactAt% used  -> sends "/compact".
      * If, AFTER that compaction settles, usage is STILL >= ClearAt% -> sends a prompt telling
        Claude to ask you what to preserve and write it to a handoff todo file, waits until that
        file is freshly written, THEN sends "/clear". The clear never fires before your answers
        are saved to disk.

    Keystroke injection uses Win32 SetForegroundWindow + SendKeys against ONE window handle that
    you capture at arm-time, so it cannot type into a random foreground app.

.PARAMETER Project
    Project directory whose session you are watching. Defaults to current directory. Used to locate
    the transcript folder under ~/.claude/projects/<encoded-path>/ and to place the handoff/log/lock.

.PARAMETER CompactAt
    Percent-used threshold that triggers /compact. Default 60.

.PARAMETER ClearAt
    Percent-used threshold (evaluated AFTER a compaction settles) that triggers the ask->todo->clear
    flow. Default 55. By design ClearAt <= CompactAt: it only fires when a compaction failed to bring
    usage back under this line.

.PARAMETER EffectiveWindow
    Token window the percentages are measured against. 0 (default) = read autoCompactWindow from
    ~/.claude/settings.json, falling back to 200000.

.PARAMETER PollSeconds
    Seconds between transcript reads. Default 20.

.PARAMETER WindowCaptureDelay
    Seconds to count down before grabbing the target window, so you can click your Claude terminal.
    Default 6. Ignored with -TargetHandle.

.PARAMETER TargetHandle
    Skip interactive capture and target this exact window handle (integer). For re-arming / scheduled use.

.PARAMETER MaxHours
    Safety cap on total runtime. Default 24.

.PARAMETER DryRun
    Log every action it WOULD take, but send no keystrokes. Use this for the first run.

.PARAMETER SelfTest
    Run offline unit checks of the percentage math and state machine. Does not read sessions or send keys.

.EXAMPLE
    # First run: prove it reads your context correctly without touching the session.
    powershell -File .\claude-context-autopilot.ps1 -DryRun

.EXAMPLE
    # Live. Run it, then click your Claude Code terminal within the countdown.
    powershell -File .\claude-context-autopilot.ps1

.EXAMPLE
    powershell -File .\claude-context-autopilot.ps1 -SelfTest
#>
[CmdletBinding()]
param(
    [string]$Project = (Get-Location).Path,
    [int]$CompactAt = 60,
    [int]$ClearAt = 55,
    [int]$EffectiveWindow = 0,
    [int]$PollSeconds = 20,
    [int]$WindowCaptureDelay = 6,
    [long]$TargetHandle = 0,
    [double]$MaxHours = 24,
    [switch]$DryRun,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# --- Pure helpers (unit-tested by -SelfTest) --------------------------------------------------

function Get-UsedTokens {
    <# Sum the context-input tokens of a usage object. output_tokens is excluded: it is the reply,
       not context fed in (and it is already folded into the NEXT turn's input_tokens). #>
    param($Usage)
    if ($null -eq $Usage) { return 0 }
    $i  = [int]($Usage.input_tokens              | ForEach-Object { $_ }) 2>$null
    $cc = [int]($Usage.cache_creation_input_tokens | ForEach-Object { $_ }) 2>$null
    $cr = [int]($Usage.cache_read_input_tokens     | ForEach-Object { $_ }) 2>$null
    return ($i + $cc + $cr)
}

function Get-UsedPct {
    param([int]$UsedTokens, [int]$Window)
    if ($Window -le 0) { return 0 }
    return [math]::Round(($UsedTokens / $Window) * 100, 1)
}

function Convert-ProjectToTranscriptDir {
    <# ~/.claude/projects encodes the project path by replacing every \ / and : with a dash. #>
    param([string]$ProjectPath)
    $encoded = $ProjectPath -replace '[\\/:]', '-'
    return (Join-Path (Join-Path $env:USERPROFILE '.claude\projects') $encoded)
}

# --- Self-test (offline) ----------------------------------------------------------------------
function Invoke-SelfTest {
    $script:fail = 0
    function Check($name, $cond) {
        if ($cond) { Write-Host "  [PASS] $name" -ForegroundColor Green }
        else { Write-Host "  [FAIL] $name" -ForegroundColor Red; $script:fail++ }
    }
    Write-Host "Self-test: token math" -ForegroundColor Cyan
    $u = [pscustomobject]@{ input_tokens = 11399; cache_creation_input_tokens = 32701; cache_read_input_tokens = 25140; output_tokens = 282 }
    Check "sums input+cache_creation+cache_read, excludes output" ((Get-UsedTokens $u) -eq 69240)
    Check "null usage is 0 tokens"                                ((Get-UsedTokens $null) -eq 0)
    Check "120000 / 200000 = 60.0%"                              ((Get-UsedPct 120000 200000) -eq 60.0)
    Check "110000 / 200000 = 55.0%"                              ((Get-UsedPct 110000 200000) -eq 55.0)
    Check "guard: zero window returns 0"                          ((Get-UsedPct 50000 0) -eq 0)

    Write-Host "Self-test: path encoding" -ForegroundColor Cyan
    $d = Convert-ProjectToTranscriptDir 'C:\Users\dev'
    Check "C:\Users\dev -> ...projects\C--Users-dev"             ($d -like '*\.claude\projects\C--Users-dev')

    Write-Host "Self-test: threshold sanity" -ForegroundColor Cyan
    Check "ClearAt <= CompactAt (clear only fires post-failed-compact)" ($ClearAt -le $CompactAt)

    Write-Host ""
    if ($script:fail -eq 0) { Write-Host "All self-tests passed." -ForegroundColor Green; exit 0 }
    else { Write-Host "$($script:fail) self-test(s) FAILED." -ForegroundColor Red; exit 1 }
}

if ($SelfTest) { Invoke-SelfTest }

# --- Runtime wiring ---------------------------------------------------------------------------
if (-not (Test-Path $Project)) { throw "Project directory not found: $Project" }
$script:TranscriptDir = Convert-ProjectToTranscriptDir $Project
$script:LogFile   = Join-Path $Project ".claude-autopilot.log"
$script:LockFile  = Join-Path $Project ".claude-autopilot.lock"
$script:TodoFile  = Join-Path $Project ".claude-autopilot-todo.md"

if ($EffectiveWindow -le 0) {
    try {
        $settings = Get-Content (Join-Path $env:USERPROFILE '.claude\settings.json') -Raw | ConvertFrom-Json
        if ($settings.autoCompactWindow -gt 0) { $EffectiveWindow = [int]$settings.autoCompactWindow }
    } catch { }
    if ($EffectiveWindow -le 0) { $EffectiveWindow = 200000 }
}

function Write-Log {
    param([string]$Message, [string]$Color = 'Gray')
    $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Message
    Write-Host $line -ForegroundColor $Color
    [System.IO.File]::AppendAllText($script:LogFile, $line + [Environment]::NewLine,
                                    (New-Object System.Text.UTF8Encoding $false))
}

function Show-Toast {
    param([string]$Title, [string]$Body)
    try {
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
            [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $texts = $xml.GetElementsByTagName('text')
        $texts[0].AppendChild($xml.CreateTextNode($Title)) | Out-Null
        $texts[1].AppendChild($xml.CreateTextNode($Body)) | Out-Null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Autopilot').Show($toast)
    } catch { try { [console]::Beep(880, 250) } catch { } }
}

# Win32 + SendKeys for window-targeted keystroke injection.
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class APWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

function Get-TargetWindow {
    if ($TargetHandle -ne 0) {
        Write-Log "Using provided target window handle: $TargetHandle" Gray
        return [IntPtr]$TargetHandle
    }
    Write-Log "Click your Claude Code terminal now. Capturing focused window in $WindowCaptureDelay s..." Yellow
    for ($s = $WindowCaptureDelay; $s -gt 0; $s--) { Write-Host "  $s..." -NoNewline; Start-Sleep -Seconds 1 }
    Write-Host ""
    $h = [APWin32]::GetForegroundWindow()
    Write-Log "Captured target window handle: $h  (re-arm with -TargetHandle $h)" Cyan
    return $h
}

function Send-ToClaude {
    <# Activate the target window and type text + Enter. No-op (logged) under -DryRun. #>
    param([IntPtr]$Hwnd, [string]$Text, [string]$What)
    if ($DryRun) { Write-Log "DRYRUN would send [$What]: $Text" Magenta; return }
    if (-not [APWin32]::IsWindow($Hwnd)) { Write-Log "Target window is gone; cannot send [$What]." Red; return }
    [APWin32]::ShowWindow($Hwnd, 9) | Out-Null   # SW_RESTORE
    [APWin32]::SetForegroundWindow($Hwnd) | Out-Null
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Write-Log "Sent [$What]: $Text" Green
}

function Get-CurrentUsage {
    <# Newest transcript = active session. Read its tail, return latest turn's used-token total, or -1. #>
    if (-not (Test-Path $script:TranscriptDir)) { return -1 }
    $newest = Get-ChildItem -Path $script:TranscriptDir -Filter '*.jsonl' -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $newest) { return -1 }
    $tail = Get-Content $newest.FullName -Tail 60 -ErrorAction SilentlyContinue
    for ($i = $tail.Count - 1; $i -ge 0; $i--) {
        $obj = $null
        try { $obj = $tail[$i] | ConvertFrom-Json } catch { continue }
        if ($obj.message -and $obj.message.usage) { return (Get-UsedTokens $obj.message.usage) }
    }
    return -1
}

# Single-line prompt (no SendKeys-special chars: + ^ % ~ ( ) { } [ ]).
$script:ClearPrompt = "AUTO-CONTEXT autopilot: a compaction just ran but context is still high. Do NOT start new work. First ask me what to preserve and what is left to do. Then write my answers and the remaining task list to the file .claude-autopilot-todo.md in the project root. Once that file is saved the watcher will clear this session automatically."

# --- Lock (one watcher per project) -----------------------------------------------------------
$lockAcquired = $false
try {
    $fs = [System.IO.File]::Open($script:LockFile, [System.IO.FileMode]::CreateNew,
                                 [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("$PID started $(Get-Date -Format o)")
        $fs.Write($bytes, 0, $bytes.Length)
    } finally { $fs.Dispose() }
    $lockAcquired = $true
} catch [System.IO.IOException] {
    throw "A context autopilot is already running for this project (lock: $($script:LockFile)). Delete it if stale."
}

# --- Main loop --------------------------------------------------------------------------------
$deadline = (Get-Date).AddHours($MaxHours)
$state = 'MONITORING'           # MONITORING | POST_COMPACT_WAIT | CLEARING
$preCompactTokens = 0
$waitStart = $null
$promptSentAt = $null
$cooldownUntil = (Get-Date).AddSeconds(-1)
$COMPACT_SETTLE_SEC = 150       # how long to wait for a /compact to take effect
$CLEAR_SAVE_TIMEOUT_SEC = 600   # give up auto-clearing if the todo file never gets written

try {
    Write-Log "Context autopilot armed for: $Project" Cyan
    Write-Log "Window=$EffectiveWindow tok | CompactAt=$CompactAt% ($([int]($EffectiveWindow*$CompactAt/100)) tok) | ClearAt=$ClearAt% ($([int]($EffectiveWindow*$ClearAt/100)) tok) | Poll=${PollSeconds}s | DryRun=$DryRun" Gray
    $target = Get-TargetWindow
    Show-Toast "Context autopilot armed" "Watching $([System.IO.Path]::GetFileName($Project)). Compact at $CompactAt%, clear at $ClearAt%."

    while ($true) {
        if ((Get-Date) -gt $deadline) { Write-Log "MaxHours cap reached. Stopping." Red; break }

        $used = Get-CurrentUsage
        if ($used -lt 0) { Start-Sleep -Seconds $PollSeconds; continue }
        $pct = Get-UsedPct $used $EffectiveWindow

        switch ($state) {
            'MONITORING' {
                Write-Log ("ctx {0}% ({1}/{2} tok)" -f $pct, $used, $EffectiveWindow) DarkGray
                if ($pct -ge $CompactAt -and (Get-Date) -ge $cooldownUntil) {
                    Write-Log "Threshold hit: $pct% >= $CompactAt%. Compacting." Yellow
                    Show-Toast "Auto-compacting" "Context at $pct%."
                    Send-ToClaude -Hwnd $target -Text "/compact" -What "compact"
                    $preCompactTokens = $used
                    $waitStart = Get-Date
                    $state = 'POST_COMPACT_WAIT'
                }
            }
            'POST_COMPACT_WAIT' {
                $dropped = $used -le ($preCompactTokens - [int]($EffectiveWindow * 0.05))   # >=5% window drop = settled
                $timedOut = ((Get-Date) - $waitStart).TotalSeconds -ge $COMPACT_SETTLE_SEC
                if ($dropped -or $timedOut) {
                    Write-Log ("Compaction settled at {0}% (dropped={1}, timeout={2})." -f $pct, $dropped, $timedOut) Gray
                    if ($pct -ge $ClearAt) {
                        Write-Log "Still >= $ClearAt% after compaction. Starting save-then-clear flow." Yellow
                        Show-Toast "Compaction insufficient" "Still $pct%. Asking what to save before clearing."
                        Send-ToClaude -Hwnd $target -Text $script:ClearPrompt -What "clear-protocol prompt"
                        $promptSentAt = Get-Date
                        $state = 'CLEARING'
                    } else {
                        Write-Log "Compaction sufficient ($pct% < $ClearAt%). Back to monitoring." Green
                        $cooldownUntil = (Get-Date).AddSeconds(60)
                        $state = 'MONITORING'
                    }
                }
            }
            'CLEARING' {
                $saved = (Test-Path $script:TodoFile) -and
                         ((Get-Item $script:TodoFile).LastWriteTime -gt $promptSentAt) -and
                         ((Get-Item $script:TodoFile).Length -gt 0)
                if ($saved) {
                    Start-Sleep -Seconds 2   # settle any in-flight write
                    Write-Log "Handoff todo saved. Clearing session." Yellow
                    Show-Toast "Clearing session" "Your handoff was saved to .claude-autopilot-todo.md"
                    Send-ToClaude -Hwnd $target -Text "/clear" -What "clear"
                    $cooldownUntil = (Get-Date).AddSeconds(90)
                    $state = 'MONITORING'
                } elseif (((Get-Date) - $promptSentAt).TotalSeconds -ge $CLEAR_SAVE_TIMEOUT_SEC) {
                    Write-Log "No handoff file after timeout. NOT clearing (your call). Back to monitoring." Red
                    Show-Toast "Auto-clear skipped" "Handoff was not saved in time; session left intact."
                    $cooldownUntil = (Get-Date).AddSeconds(120)
                    $state = 'MONITORING'
                }
            }
        }
        Start-Sleep -Seconds $PollSeconds
    }
} finally {
    if ($lockAcquired) { Remove-Item $script:LockFile -ErrorAction SilentlyContinue }
    Write-Log "Autopilot exited." Gray
}
