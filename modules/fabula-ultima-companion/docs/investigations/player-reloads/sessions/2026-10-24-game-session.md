# Session 2026-10-24 — game session (baseline)

**Window:** 2026-10-24 20:47 → 2026-10-25 02:28 (+07:00) · Foundry 12.343 · module 1.0.448
**Conditions:** no client-health logger · plain scene-change cover had no timeout · no texture repair · no cache proxy · world payload ~145 MB
**Raw data:** `Logs/debug.2026-10-24.log`, `Logs/debug.2026-10-25.log` (host, not in git) · TCP watch outputs in the 2026-10-24 Claude session scratchpad (partial, 22:39–01:22)
**Deep-dive written that night:** [../../../player-reload-investigation-2026-10-24.md](../../../player-reload-investigation-2026-10-24.md)

## Numbers

| player | route (/16) | page loads | reloads | logins | reload delay after last draw (s) |
|---|---|---|---|---|---|
| Rinri | 171.100 | 13 | **12** | 2 | 31 35 29 93 43 97 345 21 258 66 51 74 — quick 10 · mid 1 · sixMin 1 |
| Blumairwen | 27.145 | 13 | **12** | 1 | 352 37 36 362 367 338 594 335 58 37 325 11 — quick 5 · **sixMin 6** · long 1 |
| Trinio | 223.204 | 1 | 0 | 1 | — |
| Silryantish | 27.130 | 1 | 0 | 1 | — |

32 scene activations. Server vend time 3.7–5.0 s for everyone, all night.

## What this session established

1. **The page was alive when it reloaded.** In all 9 reloads the TCP watch caught, the new page's first
   connection opened while the old game socket was still up, and the old socket closed ≤1 s later.
   No DROP gap anywhere. The old sockets had lived 4–84 min.
   - This rules out Foundry's reconnect→reload path: that would leave a fresh, seconds-old socket.
   - It also rules out a crash followed by a "Reload" click: the socket would die first and leave a gap.
2. **Two delay modes.**
   - **Quick, 11–97 s after a draw.** Rinri 10 of 12, Blumairwen 5 of 12.
   - **About 5½ minutes:** Blumairwen 6 of 12, between 325 and 367 s. That's a 42 s spread over four hours.
     - One came 352 s after she joined, with no scene change in between.
3. **Paired reloads.** Three times, both players reloaded ≤60 s apart after the same scene change:
   - Valley_Map002 at 21:03.
   - Midgard_Map002 at 23:13/23:14.
   - Midgard_Map007: new page loads at 23:52:53 and 23:52:55, 10–12 s after the activation.
4. **Reload loop.**
   - After Valley_Map002, Rinri loaded four pages in 2.6 min:
     - 21:03:22, 21:03:57, 21:04:26.
     - Then back through `/join` at 21:05:48 and a final load at 21:05:59.
   - Valley_Map002 has a host-served video tile (`Fumes_02_Steam_White_400x400.webm`, 699 KB).
5. **Page-load time** (first connection → world vend):
   - Rinri 10–11 s.
   - Blumairwen 9–53 s.
6. **Scenes are light.**
   - 1254² to 2739×2515, backgrounds on Forge, all tokens PNG.
   - Host-served assets: the Fumes webm (Valley_Map002, Dragonslayer Overworld) and a 12 KB token PNG (Midgard 001/005/006/007).
   - Midgard_Map002/003 serve nothing from the host.
7. **Correction to the deep-dive.** It says Midgard_Map001 "never triggered a reload". It did:
   - Blumairwen reloaded 338 s after it, at 22:31:02.
   - Map001 was usually replaced within 6 min. Under her ~5½ min pattern, it only got a chance to trigger once.

## Generated timeline

`node ../../_tools/server-timeline.js --from "2026-10-24 20:40" --to "2026-10-25 02:30" --players ../players.json --watch Rinri,Blumairwen,Trinio,Silryantish`

32 scene activations · 12 server errors · 101 warnings

| time | event | who / scene | detail |
|---|---|---|---|
| 10-24 20:45:43 | login | GM | local |
| 10-24 20:45:50 | join | GM | vend 4160 ms · +? s after — |
| 10-24 20:46:36 | login | Onigensou | local |
| 10-24 20:46:43 | join | Onigensou | vend 4429 ms · +? s after — |
| 10-24 20:47:16 | login | Trinio | 223.204.x.x |
| 10-24 20:47:18 | login | Rinri | 171.100.x.x |
| 10-24 20:47:20 | login | Blumairwen | 27.145.x.x |
| 10-24 20:47:21 | login | Silryantish | 27.130.x.x |
| 10-24 20:47:24 | join | Trinio | vend 4468 ms · +? s after — |
| 10-24 20:47:35 | join | Rinri | vend 4200 ms · +? s after — |
| 10-24 20:47:39 | join | Silryantish | vend 4014 ms · +? s after — |
| 10-24 20:47:48 | join | Blumairwen | vend 4027 ms · +? s after — |
| 10-24 20:47:48 | login | GM II | 49.229.x.x |
| 10-24 20:48:05 | join | GM II | vend 3936 ms · +? s after — |
| 10-24 20:51:51 | RELOAD | GM II | vend 4360 ms · +? s after — · 226 s after last draw (own page load) |
| 10-24 20:53:40 | RELOAD | Blumairwen | vend 4318 ms · +? s after — · 352 s after last draw (own page load) |
| 10-24 20:56:50 | scene | **Loading Screen** | |
| 10-24 20:57:33 | scene | **Introduction** | |
| 10-24 20:59:58 | scene | **Valley of the Dragon** | |
| 10-24 21:00:35 | RELOAD | Blumairwen | vend 4443 ms · +37 s after Valley of the Dragon · 37 s after last draw (scene activation) |
| 10-24 21:02:25 | scene | **Loading Screen** | |
| 10-24 21:02:51 | scene | **Valley_Map002** | |
| 10-24 21:03:22 | RELOAD | Rinri | vend 4316 ms · +31 s after Valley_Map002 · 31 s after last draw (scene activation) |
| 10-24 21:03:27 | RELOAD | Blumairwen | vend 3740 ms · +36 s after Valley_Map002 · 36 s after last draw (scene activation) |
| 10-24 21:03:57 | RELOAD | Rinri | vend 4189 ms · +66 s after Valley_Map002 · 35 s after last draw (own page load) |
| 10-24 21:04:26 | RELOAD | Rinri | vend 4401 ms · +95 s after Valley_Map002 · 29 s after last draw (own page load) |
| 10-24 21:05:48 | login | Rinri | 171.100.x.x |
| 10-24 21:05:59 | RELOAD | Rinri | vend 4203 ms · +188 s after Valley_Map002 · 93 s after last draw (own page load) |
| 10-24 21:09:29 | RELOAD | Blumairwen | vend 4315 ms · +398 s after Valley_Map002 · 362 s after last draw (own page load) |
| 10-24 21:28:06 | scene | **Dragonslayer Overworld** | |
| 10-24 21:34:13 | RELOAD | Blumairwen | vend 4971 ms · +367 s after Dragonslayer Overworld · 367 s after last draw (scene activation) |
| 10-24 21:38:55 | scene | **Vastwind_Battlemap001** | |
| 10-24 22:14:53 | error | | Token "6rWKhWAK0QqE2hnB" does not exist! |
| 10-24 22:14:53 | error | | Token "6rWKhWAK0QqE2hnB" does not exist! |
| 10-24 22:14:53 | error | | Token "6rWKhWAK0QqE2hnB" does not exist! |
| 10-24 22:14:54 | error | | undefined id [6rWKhWAK0QqE2hnB] does not exist in the EmbeddedCollection collection. |
| 10-24 22:18:31 | error | | Token "ZmSye3n2MXLV2bKB" does not exist! |
| 10-24 22:18:31 | error | | Token "ZmSye3n2MXLV2bKB" does not exist! |
| 10-24 22:18:31 | error | | Token "ZmSye3n2MXLV2bKB" does not exist! |
| 10-24 22:18:31 | error | | Token "1Ml3EbzGKrAYCME2" does not exist! |
| 10-24 22:18:32 | error | | Token "1Ml3EbzGKrAYCME2" does not exist! |
| 10-24 22:18:32 | error | | Token "1Ml3EbzGKrAYCME2" does not exist! |
| 10-24 22:19:14 | error | | undefined id [ZmSye3n2MXLV2bKB] does not exist in the EmbeddedCollection collection. |
| 10-24 22:19:14 | error | | undefined id [1Ml3EbzGKrAYCME2] does not exist in the EmbeddedCollection collection. |
| 10-24 22:19:43 | scene | **Dragonslayer Overworld** | |
| 10-24 22:25:24 | scene | **Midgard_Map001** | |
| 10-24 22:31:02 | RELOAD | Blumairwen | vend 4207 ms · +338 s after Midgard_Map001 · 338 s after last draw (scene activation) |
| 10-24 22:40:56 | RELOAD | Blumairwen | vend 4109 ms · +932 s after Midgard_Map001 · 594 s after last draw (own page load) |
| 10-24 22:46:06 | scene | **Midgard_Map003** | |
| 10-24 22:46:49 | RELOAD | Rinri | vend 4263 ms · +43 s after Midgard_Map003 · 43 s after last draw (scene activation) |
| 10-24 22:51:41 | RELOAD | Blumairwen | vend 4344 ms · +335 s after Midgard_Map003 · 335 s after last draw (scene activation) |
| 10-24 23:06:50 | scene | **Midgard_Map001** | |
| 10-24 23:12:43 | scene | **Midgard_Map002** | |
| 10-24 23:13:41 | RELOAD | Blumairwen | vend 4518 ms · +58 s after Midgard_Map002 · 58 s after last draw (scene activation) |
| 10-24 23:14:20 | RELOAD | Rinri | vend 4444 ms · +97 s after Midgard_Map002 · 97 s after last draw (scene activation) |
| 10-24 23:30:40 | scene | **Midgard_Map001** | |
| 10-24 23:32:01 | scene | **Midgard_Map004** | |
| 10-24 23:39:10 | scene | **Midgard_Map001** | |
| 10-24 23:39:20 | scene | **Midgard_Map003** | |
| 10-24 23:40:59 | scene | **Midgard_Map001** | |
| 10-24 23:42:15 | scene | **Midgard_Map006** | |
| 10-24 23:48:00 | RELOAD | Rinri | vend 4604 ms · +345 s after Midgard_Map006 · 345 s after last draw (scene activation) |
| 10-24 23:52:43 | scene | **Midgard_Map007** | |
| 10-24 23:53:04 | RELOAD | Rinri | vend 4538 ms · +21 s after Midgard_Map007 · 21 s after last draw (scene activation) |
| 10-24 23:53:20 | RELOAD | Blumairwen | vend 4310 ms · +37 s after Midgard_Map007 · 37 s after last draw (scene activation) |
| 10-24 23:57:22 | RELOAD | Rinri | vend 4314 ms · +279 s after Midgard_Map007 · 258 s after last draw (own page load) |
| 10-25 01:11:49 | scene | **Midgard_Map006** | |
| 10-25 01:12:55 | RELOAD | Rinri | vend 4486 ms · +66 s after Midgard_Map006 · 66 s after last draw (scene activation) |
| 10-25 01:17:14 | RELOAD | Blumairwen | vend 4442 ms · +325 s after Midgard_Map006 · 325 s after last draw (scene activation) |
| 10-25 01:19:35 | scene | **Midgard_Map001** | |
| 10-25 01:26:41 | scene | **Midgard_Map005** | |
| 10-25 01:27:32 | RELOAD | Rinri | vend 4779 ms · +51 s after Midgard_Map005 · 51 s after last draw (scene activation) |
| 10-25 01:38:20 | scene | **Midgard_Map008** | |
| 10-25 02:11:34 | scene | **Dragonslayer Title** | |
| 10-25 02:11:45 | scene | **Loading Screen** | |
| 10-25 02:11:56 | RELOAD | Blumairwen | vend 4610 ms · +11 s after Loading Screen · 11 s after last draw (scene activation) |
| 10-25 02:12:03 | scene | **Valley of the Dragon - Mountain Ascending Path** | |
| 10-25 02:13:45 | scene | **Loading Screen** | |
| 10-25 02:14:27 | scene | **Ruhig Village** | |
| 10-25 02:15:54 | scene | **Loading Screen** | |
| 10-25 02:16:05 | scene | **The Wyrmwood** | |
| 10-25 02:16:15 | scene | **Loading Screen** | |
| 10-25 02:16:19 | scene | **Dragonslayer Title** | |
| 10-25 02:17:33 | RELOAD | Rinri | vend 4741 ms · +74 s after Dragonslayer Title · 74 s after last draw (scene activation) |

## Per user

| user | page loads | reloads | logins | route | vend ms | modes |
|---|---|---|---|---|---|---|
| GM (local client seen) | 1 | 0 | 1 | local | 4160–4160 | {} |
| Onigensou (local client seen) | 1 | 0 | 1 | local | 4429–4429 | {} |
| Trinio | 1 | 0 | 1 | 223.204.x.x | 4468–4468 | {} |
| Rinri | 13 | 12 | 2 | 171.100.x.x | 4189–4779 | {"quick":10,"sixMin":1,"mid":1} |
| Blumairwen | 13 | 12 | 1 | 27.145.x.x | 3740–4971 | {"sixMin":6,"quick":5,"long":1} |
| Silryantish | 1 | 0 | 1 | 27.130.x.x | 4014–4014 | {} |
| GM II | 2 | 1 | 1 | 49.229.x.x | 3936–4360 | {"mid":1} |

Paired reloads (≤60 s apart): 5
- Blumairwen 21:03:27 ↔ Rinri -5 s (after Valley_Map002)
- Blumairwen 21:03:27 ↔ Rinri +30 s (after Valley_Map002)
- Blumairwen 21:03:27 ↔ Rinri +59 s (after Valley_Map002)
- Blumairwen 23:13:41 ↔ Rinri +39 s (after Midgard_Map002)
- Blumairwen 23:53:20 ↔ Rinri -16 s (after Midgard_Map007)

