# ============================================================================
# tcp-watch.ps1 — live log of every remote client's TCP connections to Foundry
#
# Run on the HOST during a session or test (Windows PowerShell 5.1, no admin):
#   powershell -ExecutionPolicy Bypass -File tcp-watch.ps1 [-Port 30000] [-IntervalMs 500]
#
# Writes FoundryVTT/Logs/tcp-watch-<date>_<time>.log (outside the repo: it holds
# full player IPs). One line per change, with millisecond time:
#   STATE  <ip>  Established=1 SynReceived=2 ...   any change in that IP's state counts
#   OLDEST <ip>  game socket replaced (old one lived N s, since HH:mm:ss)
#   DROP   <ip>  no established connection left
#   BACK   <ip>  established again after a DROP
#
# How to read a reload (2026-10-24 findings):
#   - The new page's first connection (SynReceived / a new Established) appearing
#     BEFORE the old game socket goes away = the page was alive and navigated
#     (F5, toolbar reload, script reload).
#   - DROP first, then BACK seconds later = the page died or the network cut,
#     then something reopened it (crash + "Reload" click, discard, reconnect).
#   - Many FinWait/TimeWait right after a load = the host closing idle HTTP
#     keep-alives; normal.
# ============================================================================
param(
  [int]$Port = 30000,
  [int]$IntervalMs = 500,
  [string]$Out = ""
)

if (-not $Out) {
  $logs = Join-Path $PSScriptRoot "..\..\..\..\..\..\Logs"
  $Out = Join-Path (Resolve-Path $logs) ("tcp-watch-{0}.log" -f (Get-Date -Format "yyyy-MM-dd_HHmm"))
}
"tcp-watch port $Port every $IntervalMs ms -> $Out"
"{0}  START port={1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $Port | Out-File -FilePath $Out -Encoding utf8

$lastSig    = @{}   # ip -> state-count signature
$lastOldest = @{}   # ip -> CreationTime of the oldest Established connection
$isLocal = { param($a) $a -match '^(127\.|::1$|0\.0\.0\.0$|::$)' }

function Write-Line([string]$kind, [string]$ip, [string]$text) {
  $line = "{0}  {1,-6} {2,-16} {3}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $kind, $ip, $text
  $line
  $line | Out-File -FilePath $Out -Append -Encoding utf8
}

while ($true) {
  try {
    $all = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
           Where-Object { -not (& $isLocal $_.RemoteAddress) }
    $byIp = @{}
    foreach ($c in $all) {
      $ip = $c.RemoteAddress -replace '^::ffff:', ''
      if (-not $byIp.ContainsKey($ip)) { $byIp[$ip] = @() }
      $byIp[$ip] += $c
    }
    foreach ($ip in (@($byIp.Keys) + @($lastSig.Keys) | Select-Object -Unique)) {
      $conns = if ($byIp.ContainsKey($ip)) { $byIp[$ip] } else { @() }
      $sig = ($conns | Group-Object State | Sort-Object Name | ForEach-Object { "{0}={1}" -f $_.Name, $_.Count }) -join " "
      if (-not $sig) { $sig = "(none)" }
      if ($lastSig[$ip] -ne $sig) { Write-Line "STATE" $ip $sig; $lastSig[$ip] = $sig }

      $est = $conns | Where-Object State -eq "Established" | Sort-Object CreationTime | Select-Object -First 1
      $t = if ($est) { $est.CreationTime } else { $null }
      if ($lastOldest.ContainsKey($ip) -and $lastOldest[$ip] -ne $t) {
        if (-not $t) { Write-Line "DROP" $ip "no established connection left" }
        elseif ($lastOldest[$ip]) {
          Write-Line "OLDEST" $ip ("game socket replaced (old one lived {0:N0} s, since {1:HH:mm:ss}); oldest now since {2:HH:mm:ss.fff}" -f ($t - $lastOldest[$ip]).TotalSeconds, $lastOldest[$ip], $t)
        }
        else { Write-Line "BACK" $ip ("established again (since {0:HH:mm:ss.fff})" -f $t) }
      }
      $lastOldest[$ip] = $t
    }
  } catch {
    Write-Line "ERROR" "-" $_.Exception.Message
  }
  Start-Sleep -Milliseconds $IntervalMs
}
