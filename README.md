# KSM/USC Manager

Local web tool to manage the song database of [USC](https://github.com/Drewol/unnamed-sdvx-clone) (`maps.db`):
browse your library, manage collections (the game's playlists), check score history, listen to previews —
and **share playlists with friends** as portable files that survive different install paths.

No Node, no build step, no external dependency. PHP 8.1+ and a browser.

> **⬇ Windows, no PHP installed?** Grab the **portable bundle** from the
> [Releases page](https://github.com/ouarss/ksm-usc-manager/releases): unzip
> anywhere, double-click `start.bat` — PHP is included, nothing to install.

![Library and collections](media/ksm-usc-manager-preview.png)

## Why this exists

USC stores everything about your library in `maps.db` — including **absolute
folder paths**. This tool grew out of three needs, in that order:

1. **Surviving a library move.** Move or rename your songs folder (new drive,
   new machine…) and the game loses every song. The fix is a path update in
   the database; the tool does it in one click ("Library moved"), with an
   automatic backup first.
2. **Actually managing collections.** The in-game UI can add a song to a
   collection, but not rename, merge, delete, bulk-add hundreds of songs from
   a filtered search, or see what a collection contains at a glance. That is
   the core of this tool.
3. **Sharing collections between friends.** Raw collections are useless
   outside your machine (they reference your absolute paths). Exported
   collections store each chart's **hash** — a fingerprint of the chart file
   itself, the same key the game uses for scores. Importing matches those
   hashes against the *other* library, so it works whatever the folder
   layout, drive letter or pack names on either side. Missing charts are
   listed instead of silently dropped.

## Launch

**Portable bundle (Windows)** — see the download note at the top: unzip,
double-click `start.bat`, done.

**Windows, from source** — double-click `start.bat` (needs PHP in PATH), or from a terminal:

```
php -S 127.0.0.1:2901 -t public
```

**Apache / nginx** — point the web root at the `public/` folder (only it is
web-served; `src/`, `data/` and `backups/` stay out of reach by construction).

**Linux** — same: `php -S 127.0.0.1:2901 -t public` from the repo root, or any
PHP-capable web server.

On first launch, point the tool to your game folder (the one containing `maps.db`).
It is saved in `data/settings.json`.

![Settings — installation](media/settings.png)

## Browsing & collecting

The Explorer browses the whole library by songs, charts, artists or effectors —
filter by level (click a bar), difficulty or free text, select songs across
pages and add them to a collection in one go.

![Explorer: level filter, multi-select, Add to Collection](media/filter-select-add-to-collection.png)

![Add the selection to an existing or new collection](media/filter-select-add-to-collection-2.png)

## Scores & stats

The **Scores** page reads your play history as a whole: totals and clear rate,
plays by level (click a bar to filter), plays over time (hover to read, scroll
to zoom, drag to pan) and the top scores table.

![Scores: totals, plays by level, plays over time and top scores](media/score-stats.png)

Clicking a song opens its details with the full play history per difficulty
(score, gauge, crit/near/miss, combo) and a link to its folder.

![Per-song score history](media/score-db.png)

## Sharing collections

![Collections overview with per-collection Export](media/export-whole-collection.png)

- Open a collection → **Share** downloads a `.usc-collection.json` file.
- Your friend clicks **Import Collection** and drops the file: songs are matched
  against *their* library by chart hash (with title/artist fallback), whatever their
  folder layout. Missing charts are listed so they know what to ask for.

![Import preview: matched songs and missing charts](media/import-missing.png)

- Nobody to trade with yet? [`media/topofzeworld.json`](media/topofzeworld.json)
  is a real export (121 songs) — download it and drop it on **Import
  Collection**: the preview shows which of its charts your library already has,
  and lists the rest.
- Legacy KShootMania `.fav` files can be imported too.

![Import Collection: drop a .json or legacy .fav](media/import-collection-as-json.png)

- Every collection is also mirrored to a `.fav` file in the songs folder,
  kept in sync automatically — it survives a `maps.db` rebuild.

## Safety

- The tool writes only to the `Collections` table (and `Folders`/`Charts` paths if you
  use the explicit "library moved" fixer).
- An automatic backup of `maps.db` is made before the first write of each day, plus
  manual backups on demand — all in `backups/`.
- Close the game before making changes: it may hold the database.

## License

[MIT](LICENSE)
