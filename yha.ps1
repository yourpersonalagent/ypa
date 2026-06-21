#Requires -Version 5.1
<#
.SYNOPSIS
  Windows-native equivalent of yha.sh -- start, stop, restart the YHA stack.

.DESCRIPTION
  Functional equivalent of the bash launcher used on the Pi. Same subcommand
  surface where it makes sense; Pi-only bits (pm2, tailscale funnel, pkill,
  SO_REUSEPORT blue-green, /proc PID introspection) are skipped because they
  don't exist on Windows.

  Process management uses Start-Process + PID tracking in
  bridge\state\yha-tui\yha-windows.pids.json. Each service logs to
  bridge\state\yha-tui\logs\<svc>.log so you can tail what's running.

.USAGE
  .\yha.ps1 dev          start full stack in dev mode (bun --watch + go-core + rewind + tui-daemon)
  .\yha.ps1 build        same as dev but builds frontend with Vite first
  .\yha.ps1 tui          rebuild yha + tui-daemon, ensure daemon running, exec the TUI
  .\yha.ps1 go-build     rebuild all 4 Go binaries and exit
  .\yha.ps1 status       show which services are up (PID, port, log path)
  .\yha.ps1 stop         stop everything we started
  .\yha.ps1 restart-bridge       bounce only the bun bridge
  .\yha.ps1 restart-core         bounce only yha-core
  .\yha.ps1 restart-rewind       bounce only yha-rewind
  .\yha.ps1 restart-tui-daemon   bounce only yha-tui-daemon
  .\yha.ps1 restart-all          full bounce
  .\yha.ps1 help                 this text

.NOTES
  No pm2 equivalent on Windows. PID tracking is per-script-invocation -- if
  you start services here, stop/restart them via this script too. Processes
  started outside (e.g. `bun run dev` in a separate terminal) are NOT tracked.

  Skipped vs yha.sh:
    - pm2 (no Windows equivalent worth the complexity)
    - tailscale funnel (Pi public endpoint)
    - SO_REUSEPORT / go-reload (no kernel support on Windows)
    - pkill / ss / fuser orphan-cleanup (handled via PID file instead)
    - sudo (no privilege escalation needed on Windows for the bound ports)
#>

param(
  [Parameter(Position=0)]
  [ValidateSet('dev','build','tui','go-build','status','stop','force-stop','restart-bridge','restart-back','restart-core','restart-rewind','restart-tui-daemon','restart-all','help')]
  [string]$Mode = 'help',
  # Trailing args (`start all`, `restart bridge dev`, etc.) — mostly ignored
  # but accepted so the TUI command-bar caller doesn't blow up on extras.
  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$RestArgs = @()
)

$ErrorActionPreference = 'Stop'

# -- Paths --------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinDir    = Join-Path $ScriptDir 'bin'
$GoCoreSrc = Join-Path $ScriptDir 'go-core'
$BridgeDir = Join-Path $ScriptDir 'bridge'
$FrontDir  = Join-Path $ScriptDir 'frontend'
$StateDir  = Join-Path $BridgeDir 'state\yha-tui'
$LogDir    = Join-Path $StateDir  'logs'
$PidFile   = Join-Path $StateDir  'yha-windows.pids.json'
$EnvFile   = Join-Path $BridgeDir '.env'

$GoCoreBin    = Join-Path $BinDir 'yha-core.exe'
$GoCliBin     = Join-Path $BinDir 'yha.exe'
$RewindBin    = Join-Path $BinDir 'yha-rewind.exe'
$TuiDaemonBin = Join-Path $BinDir 'yha-tui-daemon.exe'

# Canonical project version (repo-root VERSION file). Stamped into the
# yha-core binary via -ldflags so `yha-core --version` self-reports the same
# number the bridge /v1/version endpoint serves. Single source of truth --
# see AGENTS.md. Falls back to "dev" when the file is missing.
$VersionFile = Join-Path $ScriptDir 'VERSION'
$AppVersion  = if (Test-Path $VersionFile) { (Get-Content -Raw $VersionFile).Trim() } else { 'dev' }
if (-not $AppVersion) { $AppVersion = 'dev' }

# -- Tool resolution ----------------------------------------------------------
function Resolve-Tool {
  param([string]$Name, [string[]]$Candidates)
  foreach ($c in $Candidates) {
    if (Test-Path $c) { return $c }
  }
  $found = Get-Command $Name -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  return $null
}

$GoExe  = Resolve-Tool 'go'  @('C:\Program Files\Go\bin\go.exe')
$BunExe = Resolve-Tool 'bun' @((Join-Path $env:USERPROFILE '.bun\bin\bun.exe'))

# -- Port plan (matches yha.sh go-mode) ---------------------------------------
$PublicPort = 8443           # YHA-Core front door
$NodePort   = 8442           # bun bridge upstream
$RewindPort = if ($env:YHA_REWIND_PORT) { [int]$env:YHA_REWIND_PORT } else { 8445 }

# -- Service registry ---------------------------------------------------------
# Single source of truth for what we manage. Mirrors the pm2 entries on the Pi.
$Services = @(
  @{ Name='YHA-Bridge';       Kind='bun-bridge'; Bin=$null;         Port=$NodePort;   Log='bridge.log'         }
  @{ Name='YHA-Core';       Kind='go-core';    Bin=$GoCoreBin;    Port=$PublicPort; Log='yha-core.log'       }
  @{ Name='YHA-Rewind';     Kind='rewind';     Bin=$RewindBin;    Port=$RewindPort; Log='yha-rewind.log'     }
  @{ Name='YHA-TUI-Daemon'; Kind='tui-daemon'; Bin=$TuiDaemonBin; Port=$null;       Log='yha-tui-daemon.log' }
)

# -- PID state file -----------------------------------------------------------
function Load-State {
  if (-not (Test-Path $PidFile)) { return @{} }
  try {
    $raw = Get-Content -Raw $PidFile
    $obj = $raw | ConvertFrom-Json
    $h = @{}
    foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = $p.Value }
    # Migrate the pre-rename service key so the TUI does not retain a
    # permanent stopped "YHA-Back" row beside the current YHA-Bridge row.
    if ($h.ContainsKey('YHA-Back')) {
      if (-not $h.ContainsKey('YHA-Bridge')) { $h['YHA-Bridge'] = $h['YHA-Back'] }
      $h.Remove('YHA-Back')
    }
    return $h
  } catch {
    Write-Host "WARN: pid file unreadable, resetting" -ForegroundColor Yellow
    return @{}
  }
}

function Save-State {
  param([hashtable]$State)
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  $json = $State | ConvertTo-Json -Depth 4
  # WriteAllText with UTF8Encoding(false) writes UTF-8 WITHOUT BOM. PS5.1's
  # `Set-Content -Encoding utf8` always writes a BOM, which the Go JSON
  # parser on the consumer side reports as "invalid character 'ï'".
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($PidFile, $json, $utf8NoBom)
}

function Get-LiveProcess {
  param([int]$ProcessId, [string]$ExpectedName)
  if ($ProcessId -le 0) { return $null }
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { return $null }
  # Defense against PID reuse: confirm the image name matches what we
  # recorded. Without this, a stale PID from a killed yha-core that's been
  # recycled by Windows would cause us to "stop" a random user process.
  if ($ExpectedName -and $proc.ProcessName -ne $ExpectedName) { return $null }
  return $proc
}

# -- .env loader (read bearer token + bridge keys into our env) ---------------
function Import-DotEnv {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { return }
    $eq = $line.IndexOf('=')
    if ($eq -le 0) { return }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim()
    if (-not ($val.StartsWith('"') -or $val.StartsWith("'"))) {
      $h = $val.IndexOf(' #')
      if ($h -ge 0) { $val = $val.Substring(0, $h).Trim() }
    }
    if ($val.Length -ge 2) {
      $first = $val[0]; $last = $val[$val.Length - 1]
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $val = $val.Substring(1, $val.Length - 2)
      }
    }
    Set-Item -Path "Env:$key" -Value $val
  }
}

# -- Bridge shared-secret bootstrap -------------------------------------------
# YHA_BRIDGE_KEY is the secret the bun bridge and yha-core share to authorize
# the /internal/* + /proxy/* calls between them. yha.sh generates it on first
# run; this Windows launcher historically did NOT, so a fresh checkout had no
# key and the two processes each fell back to their own ad-hoc secret -- every
# cross-service call then failed auth. With auth-enforce default-on that
# surfaces as the bridge/core appearing to hang or refusing requests. Generate
# and persist once so both inherit the same value through the process env
# (Start-Process below inherits our env, exactly like Import-DotEnv's vars).
function Ensure-BridgeKey {
  param([string]$Path)
  if ($env:YHA_BRIDGE_KEY) { return }   # already present (loaded from .env)
  # It may exist in the file but not yet in our env (e.g. called before
  # Import-DotEnv). Load it rather than minting a second, conflicting key.
  if (Test-Path $Path) {
    $line = Get-Content $Path -ErrorAction SilentlyContinue |
      Where-Object { $_ -match '^\s*YHA_BRIDGE_KEY\s*=\s*\S' } |
      Select-Object -First 1
    if ($line) {
      $val = ($line -replace '^\s*YHA_BRIDGE_KEY\s*=\s*', '').Trim().Trim('"').Trim("'")
      if ($val) { Set-Item -Path 'Env:YHA_BRIDGE_KEY' -Value $val; return }
    }
  }
  # Mint 32 random bytes -> 64 hex chars, matching `openssl rand -hex 32`.
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $key = [System.BitConverter]::ToString($bytes).Replace('-', '').ToLower()
  # Append without a BOM (PS5.1's Set-Content -Encoding utf8 would add one).
  # Leading CRLF guards against a .env that doesn't end in a newline.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::AppendAllText($Path, "`r`nYHA_BRIDGE_KEY=$key`r`n", $utf8NoBom)
  Set-Item -Path 'Env:YHA_BRIDGE_KEY' -Value $key
  Write-Host "-> Generated YHA_BRIDGE_KEY (first run) -> $Path" -ForegroundColor Cyan
}

# -- Build helpers (incremental -- go build is a no-op when fresh) ------------
function Invoke-GoBuild {
  param([string]$OutFile, [string]$Pkg, [string]$Ldflags = '')
  if (-not $GoExe) { throw "go not found on PATH or at C:\Program Files\Go\bin\go.exe" }
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  Write-Host "-> go build $Pkg -> $OutFile" -ForegroundColor Cyan
  Push-Location $GoCoreSrc
  try {
    if ($Ldflags) {
      & $GoExe build -ldflags $Ldflags -o $OutFile $Pkg
    } else {
      & $GoExe build -o $OutFile $Pkg
    }
    if ($LASTEXITCODE -ne 0) { throw "go build $Pkg failed" }
  } finally {
    Pop-Location
  }
}

function Ensure-Builds {
  # Go's build cache makes this fast (<1s) when sources are unchanged, so we
  # don't bother with mtime checks like yha.sh does -- just always build.
  Invoke-GoBuild $GoCoreBin    './cmd/yha-core' "-X main.version=$AppVersion"
  Invoke-GoBuild $GoCliBin     './cmd/yha'
  Invoke-GoBuild $RewindBin    './cmd/yha-rewind'
  Invoke-GoBuild $TuiDaemonBin './cmd/yha-tui-daemon'
}

function Ensure-Build-TuiPair {
  Invoke-GoBuild $GoCliBin     './cmd/yha'
  Invoke-GoBuild $TuiDaemonBin './cmd/yha-tui-daemon'
}

# -- Process start / stop -----------------------------------------------------
function Start-Service {
  param(
    [string]$Name,
    [string]$Exe,
    [string[]]$ArgList = @(),
    [string]$WorkDir = $ScriptDir,
    [string]$LogName,
    [hashtable]$EnvOverrides = @{}
  )
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $logPath = Join-Path $LogDir $LogName

  # Apply env overrides for this process only by setting them on our env,
  # capturing originals, starting (Start-Process inherits), then restoring.
  $originals = @{}
  foreach ($k in $EnvOverrides.Keys) {
    $originals[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, $EnvOverrides[$k], 'Process')
  }
  try {
    Write-Host "-> Starting $Name (log: $logPath)" -ForegroundColor Green
    $sp = @{
      FilePath               = $Exe
      WorkingDirectory       = $WorkDir
      PassThru               = $true
      WindowStyle            = 'Hidden'
      RedirectStandardOutput = $logPath
      RedirectStandardError  = "$logPath.err"
    }
    if ($ArgList.Count -gt 0) { $sp.ArgumentList = $ArgList }
    $p = Start-Process @sp
  } finally {
    foreach ($k in $originals.Keys) {
      [Environment]::SetEnvironmentVariable($k, $originals[$k], 'Process')
    }
  }

  $state = Load-State
  $state[$Name] = @{
    pid       = $p.Id
    proc_name = $p.ProcessName
    exe       = $Exe
    args      = ($ArgList -join ' ')
    log       = $logPath
    started   = (Get-Date -Format 'o')
  }
  Save-State $state
  return $p
}

function Kill-ImageNames {
  # Cross-session belt-and-suspenders. Stop-Process -Name handles same-
  # session kills cleanly; taskkill /F /IM is the cross-session fallback
  # (needs admin to actually succeed cross-session, but harmless to run
  # in either case).
  #
  # Note on suppression: PowerShell 5.1's `2>&1 | Out-Null` does NOT
  # fully silence native-command stderr -- each line gets wrapped as a
  # NativeCommandError ErrorRecord that surfaces to the console anyway
  # (e.g. "Der Prozess wurde nicht gefunden" when there's nothing to
  # kill). Shelling through cmd.exe with `>nul 2>nul` redirects at the
  # OS level, never enters PowerShell's error stream.
  #
  # If your bun keeps surviving force-stop, you're hitting a true
  # cross-session zombie; relaunch PowerShell as Administrator.
  param([string[]]$Names = @())
  foreach ($n in $Names) {
    Stop-Process -Name $n -Force -ErrorAction SilentlyContinue
    $null = cmd /c "taskkill /F /IM ""$n.exe"" 1>nul 2>nul"
  }
  # taskkill leaves $LASTEXITCODE=128 when nothing matched (the common
  # case when called pre-emptively). Reset so this helper doesn't poison
  # the script's overall exit code -- callers like the TUI job runner
  # interpret non-zero as failure.
  $global:LASTEXITCODE = 0
  Start-Sleep -Milliseconds 250
}

function Kill-OrphanHarness {
  # Reap orphaned harness children -- the upstream `claude` CLI that
  # go-core (and, on the legacy path, the bun bridge) spawns to run a
  # chat turn.
  #
  # WHY THIS EXISTS. On Windows a child is NOT killed when its parent
  # dies -- there is no POSIX process-group cascade. go-core runs the
  # binary via exec.CommandContext, which only kills it while go-core is
  # alive to cancel the context; a `taskkill /F` (how we stop services
  # here) or a crash leaves the claude.exe running, holding ~50-320MB RAM
  # + an OAuth/session slot, until it happens to notice its broken stdio
  # and exit (observed: 1-2h later, if ever). On the 8GB box a handful of
  # these compound into real memory pressure. go-core now assigns each
  # child to a kill-on-close Job Object (claudebinary/jobobject_windows.go)
  # so the kernel reaps them when go-core dies; this function is the
  # belt-and-suspenders backstop that also catches orphans from go-core
  # builds predating that fix and from the legacy bun spawn path.
  #
  # CRITICAL SAFETY. Scoped strictly by ExecutablePath to the harness
  # binary we ship ($BinDir\claude.exe). We must NEVER kill claude.exe by
  # image name: that would also take down the user's Claude *desktop* app
  # (under \WindowsApps\) and any Claude *Code* CLI session (under
  # %APPDATA%\...\claude-code\) -- including one that may be driving this
  # very command.
  #
  # Only TRUE orphans are reaped: a harness child whose parent process is
  # no longer alive. That keeps this safe to call from a bun-only bounce
  # while go-core (the real owner of the live children) keeps running --
  # those children still have a live parent and are left untouched.
  $harness = Join-Path $BinDir 'claude.exe'
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $harness })
  $reaped = 0
  foreach ($p in $procs) {
    $parentAlive = $false
    if ($p.ParentProcessId) {
      if (Get-Process -Id ([int]$p.ParentProcessId) -ErrorAction SilentlyContinue) {
        $parentAlive = $true
      }
    }
    if ($parentAlive) { continue }
    try {
      Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction Stop
      Write-Host ("  reaped orphan harness pid {0} (dead parent {1})" -f $p.ProcessId, $p.ParentProcessId) -ForegroundColor Yellow
      $reaped++
    } catch {
      Write-Host ("  could not reap harness pid {0}: {1}" -f $p.ProcessId, $_.Exception.Message) -ForegroundColor DarkGray
    }
  }
  if ($reaped -gt 0) {
    Write-Host ("OK: reaped {0} orphan harness process(es)" -f $reaped) -ForegroundColor Green
  }
  # A Get-Process / Stop-Process miss must not poison the script exit code
  # (the TUI job runner treats non-zero as failure).
  $global:LASTEXITCODE = 0
}

function Stop-Service {
  param([string]$Name)
  $state = Load-State
  if (-not $state.ContainsKey($Name)) {
    Write-Host "  ${Name}: no record" -ForegroundColor DarkGray
    return $false
  }
  $rec = $state[$Name]
  $proc = Get-LiveProcess -ProcessId ([int]$rec.pid) -ExpectedName $rec.proc_name
  if ($proc) {
    Write-Host "-> Stopping $Name (pid $($rec.pid))" -ForegroundColor Yellow
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {
      Write-Host "  failed: $($_.Exception.Message)" -ForegroundColor Red
      return $false
    }
  } else {
    Write-Host "  $Name pid $($rec.pid) not alive (stale record)" -ForegroundColor DarkGray
  }
  $state.Remove($Name)
  Save-State $state
  return $true
}

function Wait-Port {
  param([int]$Port, [int]$TimeoutSec = 60)
  for ($i = 1; $i -le $TimeoutSec; $i++) {
    try {
      $c = New-Object System.Net.Sockets.TcpClient
      $c.Connect('127.0.0.1', $Port)
      $c.Close()
      return $true
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  return $false
}

# -- Service-specific start commands (mirror yha.sh start blocks) -------------
function Start-Bridge {
  param([string]$YhaMode = 'dev')
  if (-not $BunExe) { throw "bun not found at $(Join-Path $env:USERPROFILE '.bun\bin\bun.exe')" }
  $envs = @{
    PORT         = "$NodePort"
    USE_HTTP     = 'true'
    YHA_MODE     = $YhaMode
    YHA_BACKEND  = 'go'
    # go-core fronts the bridge on :$PublicPort and dials it over loopback at
    # 127.0.0.1:$NodePort. Bind the bridge to loopback so :$NodePort isn't
    # reachable off-host (tailnet/LAN) — go-core is its only client here.
    YHA_BIND_HOST = '127.0.0.1'
    YHA_USE_DIST = if ($YhaMode -eq 'dev') { 'false' } else { 'true' }
  }
  # Avoid the `bun run dev` indirection — on Windows it forks an outer
  # dispatcher that exits quickly after spawning `bun --watch server.ts`,
  # so Start-Process records the dispatcher's PID and yha.ps1 status
  # immediately reports YHA-Bridge as "dead (stale pid)" even though the
  # actual server child + MCPs are alive. Spawning `bun --watch server.ts`
  # (or `bun server.ts` for build mode) directly puts the long-lived
  # process in our PID file. Args mirror bridge/package.json scripts.
  $bunArgs = if ($YhaMode -eq 'dev') { @('--watch', 'server.ts') } else { @('server.ts') }
  Start-Service -Name 'YHA-Bridge' -Exe $BunExe -ArgList $bunArgs `
    -WorkDir $BridgeDir -LogName 'bridge.log' -EnvOverrides $envs | Out-Null
}

function Start-GoCore {
  Start-Service -Name 'YHA-Core' -Exe $GoCoreBin `
    -ArgList @("--port=$PublicPort", "--node-url=http://127.0.0.1:$NodePort") `
    -WorkDir $ScriptDir -LogName 'yha-core.log' | Out-Null
}

function Start-Rewind {
  Start-Service -Name 'YHA-Rewind' -Exe $RewindBin `
    -ArgList @("--port=$RewindPort", "--rewind-dir=$BridgeDir\rewind", "--repo-root=$ScriptDir") `
    -WorkDir $ScriptDir -LogName 'yha-rewind.log' | Out-Null
}

function Start-TuiDaemon {
  Start-Service -Name 'YHA-TUI-Daemon' -Exe $TuiDaemonBin `
    -WorkDir $ScriptDir -LogName 'yha-tui-daemon.log' | Out-Null
}

# -- Subcommands --------------------------------------------------------------
function Cmd-Status {
  $state = Load-State
  $rows = foreach ($svc in $Services) {
    $name = $svc.Name
    $portOwner = $null
    if ($svc.Port) {
      # Port-based reality check: even if the tracked PID is dead/wrong
      # (cross-session zombie or wrapper/child fork case), the service is
      # effectively "online" if its port is bound by a process matching
      # its expected image. This is what users care about.
      $portOwner = (Get-NetTCPConnection -LocalPort $svc.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)
    }
    if (-not $state.ContainsKey($name)) {
      if ($portOwner) {
        $oproc = Get-Process -Id $portOwner -ErrorAction SilentlyContinue
        $pname = if ($oproc) { $oproc.ProcessName } else { '?' }
        [PSCustomObject]@{ Name = $name; PID = "${portOwner}*"; Status = "online ($pname, untracked)"; Port = $svc.Port; Log = '' }
      } else {
        [PSCustomObject]@{ Name = $name; PID = '-'; Status = 'not started'; Port = $svc.Port; Log = '' }
      }
      continue
    }
    $rec = $state[$name]
    $proc = Get-LiveProcess -ProcessId ([int]$rec.pid) -ExpectedName $rec.proc_name
    if ($proc) {
      $status = 'online'
      $pid_ = $rec.pid
    } elseif ($portOwner) {
      # Tracked PID is dead but the port is bound -- a different process
      # (often a cross-session zombie that survived force-stop) is
      # actually serving. Flag the discrepancy so the user knows the
      # tracked PID can't be killed cleanly via Stop-Service.
      $status = 'online (untracked owner)'
      $pid_ = "$($rec.pid) / actual:$portOwner"
    } else {
      $status = 'dead (stale pid)'
      $pid_ = $rec.pid
    }
    [PSCustomObject]@{
      Name   = $name
      PID    = $pid_
      Status = $status
      Port   = $svc.Port
      Log    = $rec.log
    }
  }
  $rows | Format-Table -AutoSize
}

function Cmd-Stop {
  param(
    # Mirror yha.sh: the TUI daemon owns the operator console (the very
    # thing that may have issued this stop) and is intentionally left
    # alone unless the caller explicitly asks. Set -IncludeTuiDaemon
    # when you really want to bounce it -- and don't do it from inside
    # a job running under that daemon.
    [switch]$IncludeTuiDaemon
  )
  foreach ($svc in $Services) {
    if (-not $IncludeTuiDaemon -and $svc.Name -eq 'YHA-TUI-Daemon') {
      continue
    }
    Stop-Service -Name $svc.Name | Out-Null
  }
  # go-core (just stopped above) is the parent of any live `claude` harness
  # child; with it gone they are orphans. Reap them so they don't linger
  # holding RAM + a session slot. Path-scoped + dead-parent-only (safe).
  Kill-OrphanHarness
  Write-Host "OK: stopped all tracked services (tui-daemon preserved)" -ForegroundColor Green
}

function Cmd-Dev { Start-Stack -DevMode }
function Cmd-Build { Start-Stack }

function Start-Stack {
  param([switch]$DevMode)
  $yhaMode = if ($DevMode) { 'dev' } else { 'build' }

  Import-DotEnv $EnvFile
  Ensure-BridgeKey $EnvFile
  Ensure-Builds

  # Tear down everything EXCEPT the tui-daemon. yha.sh does the same --
  # the daemon is the operator console and routinely runs the very `:start`
  # / `:restart-all` job that brought us here, so killing it would sever
  # the user's TUI mid-flight and orphan our own parent shell.
  Cmd-Stop
  # Cross-session cleanup: zombie bun / yha-core / yha-rewind from previous
  # shell sessions still hold their ports. Stop-Service above couldn't
  # touch them (different session). taskkill by image name does. Skip
  # yha-tui-daemon so an open TUI keeps its socket -- same reasoning as
  # the Cmd-Stop exclusion.
  Kill-ImageNames -Names @('bun', 'yha-core', 'yha-rewind')
  # Boot sweep: a previous run that crashed or was hard-killed may have
  # left orphaned `claude` harness children (their go-core/bun parent is
  # now gone). Reap them before we start fresh so they don't pile onto
  # the new stack's memory budget. See Kill-OrphanHarness.
  Kill-OrphanHarness

  if (-not $DevMode) {
    Write-Host "-> Building frontend with Vite..." -ForegroundColor Cyan
    Push-Location $FrontDir
    try {
      & $BunExe run build
      if ($LASTEXITCODE -ne 0) { throw "vite build failed" }
    } finally { Pop-Location }
  }

  Start-Bridge -YhaMode $yhaMode

  Write-Host "-> Waiting for bun bridge on :$NodePort..." -ForegroundColor Cyan
  if (-not (Wait-Port -Port $NodePort -TimeoutSec 60)) {
    Write-Host "WARN: bun bridge not responding on :$NodePort after 60s -- starting go-core anyway." -ForegroundColor Yellow
  }

  Start-GoCore
  Start-Rewind
  # Start tui-daemon ONLY if not already running. Mirrors yha.sh's
  # "leaving it running" branch, so dashboards stay connected across
  # restart-all cycles.
  $state = Load-State
  $needsTuiDaemon = $true
  if ($state.ContainsKey('YHA-TUI-Daemon')) {
    $rec = $state['YHA-TUI-Daemon']
    if (Get-LiveProcess -ProcessId ([int]$rec.pid) -ExpectedName $rec.proc_name) {
      Write-Host "-> YHA-TUI-Daemon already running (pid $($rec.pid)) -- leaving it alone" -ForegroundColor DarkGray
      $needsTuiDaemon = $false
    }
  }
  if ($needsTuiDaemon) { Start-TuiDaemon }

  Write-Host ""
  Write-Host "OK: YHA ($yhaMode, go-mode) -- Go on :$PublicPort, bun on :$NodePort, rewind on :$RewindPort" -ForegroundColor Green
  Write-Host ""
  Cmd-Status
  Write-Host ""
  Write-Host "Logs:           Get-Content -Tail 50 -Wait $LogDir\<service>.log" -ForegroundColor DarkGray
  Write-Host "Open the TUI:   .\yha.ps1 tui" -ForegroundColor DarkGray
  Write-Host "Stop:           .\yha.ps1 stop -IncludeTuiDaemon" -ForegroundColor DarkGray
}

function Cmd-Tui {
  # Mirror yha.sh's `tui` shortcut: rebuild yha + tui-daemon, ensure daemon
  # is up, exec the TUI. Doesn't touch the bridge / go-core / rewind -- they
  # may or may not be running; the TUI gracefully degrades.
  Ensure-Build-TuiPair

  $state = Load-State
  if ($state.ContainsKey('YHA-TUI-Daemon')) {
    $rec = $state['YHA-TUI-Daemon']
    if (Get-LiveProcess -ProcessId ([int]$rec.pid) -ExpectedName $rec.proc_name) {
      Write-Host "-> YHA-TUI-Daemon already running (pid $($rec.pid)) -- bouncing for fresh binary" -ForegroundColor Cyan
      Stop-Service -Name 'YHA-TUI-Daemon' | Out-Null
    }
  }
  # Catch cross-session zombies that Stop-Service couldn't reach -- the
  # AF_UNIX socket would otherwise stay bound and the new daemon would
  # fail to claim it.
  Kill-ImageNames -Names @('yha-tui-daemon')
  Start-TuiDaemon

  # Give the daemon a moment to bind its AF_UNIX socket.
  Start-Sleep -Milliseconds 500

  Import-DotEnv $EnvFile
  Write-Host "-> Launching yha tui..." -ForegroundColor Green
  & $GoCliBin tui
}

function Cmd-GoBuild { Ensure-Builds; Write-Host "OK: Go binaries built" -ForegroundColor Green }

function Cmd-ForceStop {
  # Nuclear option: taskkill /F on every yha-* exe by image name,
  # ignoring our PID file. Use when daemons get stranded across shell
  # sessions (e.g. a yha.exe tui in another window left its daemon
  # behind, and our session-scoped Stop-Process can't reach it).
  #
  # Requires nothing special if the target processes are in the same
  # user session. Cross-session kills need admin -- if a kill fails
  # with "access denied", relaunch this PowerShell as Administrator.
  $names = @('yha-tui-daemon','yha-core','yha-rewind','yha','bun')
  foreach ($n in $names) {
    # See Kill-ImageNames for the cmd/c rationale (PS5.1 stderr leak).
    $null = cmd /c "taskkill /F /IM ""$n.exe"" 1>nul 2>nul"
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  killed $n.exe" -ForegroundColor Yellow
    }
  }
  # Now that the chat-owning services are gone, reap their orphaned
  # `claude` harness children too (path-scoped; never touches the desktop
  # app or a Claude Code CLI session). See Kill-OrphanHarness.
  Kill-OrphanHarness
  # Reset so taskkill's "process not found" (128) doesn't surface as
  # the script's exit code -- TUI job runner treats non-zero as failure.
  $global:LASTEXITCODE = 0
  # Wipe the PID file too -- everything we knew about is gone now.
  if (Test-Path $PidFile) { Remove-Item -Force $PidFile }
  Write-Host "OK: force-stop complete (pid file cleared)" -ForegroundColor Green
}

function Cmd-Restart-Bridge {
  Import-DotEnv $EnvFile
  Ensure-BridgeKey $EnvFile
  Stop-Service -Name 'YHA-Bridge' | Out-Null
  # Cross-session safety: bun on Windows often outlives our tracked
  # PID (started from a different shell, can't be killed by Stop-Process).
  # taskkill /F /IM bun.exe nukes the stragglers so the next Start-Bridge
  # doesn't hit EADDRINUSE on :8442. Also kills MCP children (also bun).
  Kill-ImageNames -Names @('bun')
  # Legacy spawn path: if this bun bridge owned any `claude` harness
  # children, they're now orphaned. Reap them. go-core's own live
  # children are spared -- Kill-OrphanHarness only touches dead-parent
  # orphans, and go-core is left running here.
  Kill-OrphanHarness
  $yhaMode = if ($env:YHA_MODE) { $env:YHA_MODE } else { 'dev' }
  Start-Bridge -YhaMode $yhaMode
  Write-Host "OK: YHA-Bridge bounced ($yhaMode mode)" -ForegroundColor Green
}

function Cmd-Restart-Core {
  # Load .env + bridge key BEFORE starting go-core, exactly as Start-Stack
  # does. Start-GoCore relies on Start-Process inheriting our env; without
  # these, a bounce from a clean shell launches go-core with empty
  # WORKOS_*/SESSION_SECRET, so auth.Classify sees cfg.Enabled()==false and
  # returns DecisionAllow for every request -- the Go auth gate silently
  # stops enforcing on native handlers (/v1/stream-direct, /v1/tools/exec).
  Import-DotEnv $EnvFile
  Ensure-BridgeKey $EnvFile
  Invoke-GoBuild $GoCoreBin './cmd/yha-core' "-X main.version=$AppVersion"
  Stop-Service -Name 'YHA-Core' | Out-Null
  Kill-ImageNames -Names @('yha-core')
  # go-core owns the live `claude` harness children; with it stopped they
  # are orphans. Reap before relaunch so a bounce doesn't leak them.
  Kill-OrphanHarness
  Start-GoCore
  Write-Host "OK: YHA-Core bounced" -ForegroundColor Green
}

function Cmd-Restart-Rewind {
  # Same env-inheritance rule as Cmd-Restart-Core: yha-rewind calls
  # go-core's /internal/sessions-summary with x-bridge-key=$YHA_BRIDGE_KEY
  # (main.go handleSessions), so a bounce from a clean shell would lose the
  # key and the rewind sessions panel would 401.
  Import-DotEnv $EnvFile
  Ensure-BridgeKey $EnvFile
  Invoke-GoBuild $RewindBin './cmd/yha-rewind'
  Stop-Service -Name 'YHA-Rewind' | Out-Null
  Kill-ImageNames -Names @('yha-rewind')
  Start-Rewind
  Write-Host "OK: YHA-Rewind bounced" -ForegroundColor Green
}

function Cmd-Restart-TuiDaemon {
  # Match Start-Stack, which starts the daemon only after Import-DotEnv +
  # Ensure-BridgeKey. The daemon is the parent of operator jobs (it forks
  # restart-* and friends), so it must carry the same enforcing env for the
  # jobs it spawns to inherit.
  Import-DotEnv $EnvFile
  Ensure-BridgeKey $EnvFile
  Invoke-GoBuild $TuiDaemonBin './cmd/yha-tui-daemon'
  Stop-Service -Name 'YHA-TUI-Daemon' | Out-Null
  Kill-ImageNames -Names @('yha-tui-daemon')
  # Belt-and-suspenders for AF_UNIX on Windows: after hard kill the socket
  # file or endpoint can linger briefly and cause the fresh daemon's
  # net.Listen to fail (process prints "listening" then exits 0). Pre-remove
  # the sidecars the daemon itself also cleans, then give the kernel a
  # moment before the new Start-Process.
  Start-Sleep -Milliseconds 250
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $StateDir 'daemon.sock'), (Join-Path $StateDir 'daemon.pid')
  Start-TuiDaemon
  Start-Sleep -Milliseconds 400
  Write-Host "OK: YHA-TUI-Daemon bounced" -ForegroundColor Green
}

function Cmd-Restart-All {
  Import-DotEnv $EnvFile
  $devOrBuild = if ($env:YHA_MODE) { $env:YHA_MODE } else { 'dev' }
  if ($devOrBuild -eq 'dev') { Start-Stack -DevMode } else { Start-Stack }
}

function Cmd-Help {
  Get-Content $MyInvocation.PSCommandPath | Select-Object -First 50
}

# -- Dispatch -----------------------------------------------------------------
switch ($Mode) {
  'help'                  { Cmd-Help }
  'dev'                   { Cmd-Dev }
  'build'                 { Cmd-Build }
  'tui'                   { Cmd-Tui }
  'go-build'              { Cmd-GoBuild }
  'status'                { Cmd-Status }
  'stop'                  { Cmd-Stop }
  'force-stop'            { Cmd-ForceStop }
  'restart-bridge'        { Cmd-Restart-Bridge }
  'restart-back'          { Cmd-Restart-Bridge }
  'restart-core'          { Cmd-Restart-Core }
  'restart-rewind'        { Cmd-Restart-Rewind }
  'restart-tui-daemon'    { Cmd-Restart-TuiDaemon }
  'restart-all'           { Cmd-Restart-All }
}
