# Fabula Ultima — Co-Dev Setup

This repo tracks the FoundryVTT V12 **Data** folder for the *Fabula Ultima* game.
Pulling this repo and following the steps below gives you an identical local setup.

## What's in the repo

| Path | What it is |
|---|---|
| `worlds/fabula-ultima-2/` | Full world state — scenes, actors, items, journals, etc. (LevelDB) |
| `worlds/fabula-ultima-2/packs/` | Compendium packs — classes, skills, action macros |
| `worlds/fabula-ultima-2/assets/` | Locally uploaded images and audio |
| `modules/fabula-ultima-companion/` | Custom companion module (scripts, macros) |
| `systems/custom-system-builder/` | Game system (v4.8.5) |
| `required-modules.json` | List of add-on modules to install from the package manager |

## Prerequisites

- **FoundryVTT V12** — verified on build `12.343`
- **Git** and **PowerShell** (already on Windows)

## First-time setup

### 1. Clone into your FoundryVTT Data folder

The repo must live at `%localappdata%\FoundryVTT\Data\` so Foundry finds it automatically.

```powershell
# Back up your existing Data folder first if needed, then:
cd "$env:LOCALAPPDATA\FoundryVTT"
git clone https://github.com/Onigensou/fabula-ultima.git Data
```

If you already have a Data folder, clone elsewhere and copy/merge selectively.

### 2. Run the setup check

```powershell
cd "$env:LOCALAPPDATA\FoundryVTT\Data"
.\setup.ps1
```

This will tell you which modules are missing.

### 3. Install missing modules

Open **FoundryVTT > Setup > Add-on Modules > Install Module** and install
every module listed in `required-modules.json` by its package ID.

> `fabula-ultima-companion` is already in the repo — do **not** install it
> from the package manager or you will get a duplicate.

Notes on specific modules:
- `JB2A_DnD5e` — large asset pack, slow to download
- `theripper-premium-hub` — requires a Theripper account/license

### 4. Open Foundry and load the world

Launch FoundryVTT, go to **Game Worlds**, and open **Fabula Ultima**.

---

## Commit workflow (important)

FoundryVTT keeps its world data in LevelDB databases. LevelDB places a `LOCK`
file while it is open, and writes to binary `.ldb` files continuously during
a session. Committing while Foundry is running will produce a corrupt or
incomplete snapshot.

**Always follow this order:**

```
1. Close FoundryVTT completely
2. git pull  (get peers' latest changes first)
3. git add / git commit
4. git push
5. Open FoundryVTT
```

**Before your peer opens Foundry:**

```
1. Close FoundryVTT completely (if open)
2. git pull
3. Run .\setup.ps1 to confirm no lock files
4. Open FoundryVTT
```

---

## Repo layout (reference)

```
Data/
├── .gitignore
├── README.md
├── required-modules.json       <- module install list
├── setup.ps1                   <- setup check script
├── modules/
│   └── fabula-ultima-companion/  <- tracked (custom module)
├── systems/
│   └── custom-system-builder/  <- tracked (game system)
└── worlds/
    └── fabula-ultima-2/
        ├── world.json
        ├── assets/             <- tracked (uploaded media)
        ├── data/               <- tracked (live world LevelDB)
        └── packs/              <- tracked (compendium LevelDB)
```

---

## Troubleshooting

**"World failed to load" after pulling**
- Make sure you closed Foundry on the other machine before the commit.
  Stale WAL log files can cause LevelDB to replay conflicting writes.
  Run `.\setup.ps1` to check for LOCK files.

**Missing actors / scenes after pulling**
- The world data is in `worlds/fabula-ultima-2/data/`. Check `git status`
  to confirm those files were committed (they should show as `.ldb` files).

**Module errors on startup**
- Re-run `.\setup.ps1` to see which modules are missing and install them.
