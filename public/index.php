<?php $v = '2.7.14'; ?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KSM/USC Manager</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect x='1' y='3' width='6' height='10' rx='1' fill='%2300C8FF'/><rect x='9' y='3' width='6' height='10' rx='1' fill='%23FF2E92'/></svg>">
    <link rel="stylesheet" href="assets/css/app.css?v=<?= $v ?>">
</head>
<body>

<div id="setup" class="setup hidden">
    <div class="setup-card">
        <h1 class="brand">KSM/USC <span>Manager</span></h1>
        <p>Point the tool to your game installation folder — the one containing <code>maps.db</code>.</p>
        <form id="setup-form">
            <input type="text" id="setup-root" placeholder="e.g. Z:\Games\USC" autocomplete="off">
            <button type="button" class="btn hidden" id="setup-browse">Browse…</button>
            <button type="submit" class="btn btn-primary">Connect</button>
        </form>
        <p id="setup-error" class="setup-error hidden"></p>
    </div>
</div>

<div id="app" class="app hidden">

    <header class="topbar">
        <button class="btn btn-quiet btn-menu" id="btn-menu" aria-label="Open menu">Menu</button>
        <h1 class="brand">KSM/USC <span>Manager</span></h1>
        <p id="stats" class="stats"></p>
        <div class="topbar-actions">
            <button class="btn" id="btn-import">Import Collection</button>
            <button class="btn btn-quiet" id="btn-settings">Settings</button>
        </div>
    </header>

    <aside class="sidebar">
        <div class="searchbox">
            <input type="search" id="search" placeholder="Title, artist, effector…" autocomplete="off">
        </div>

        <nav class="nav">
            <button class="nav-label nav-label-nautica nav-section-link hidden" id="nautica-section">Nautica<span class="count nautica-count hidden" id="nautica-badge"></span></button>

            <button class="nav-label nav-label-collections nav-section" data-target="nav-collections">Collections<span class="nav-twisty">−</span></button>
            <ul id="nav-collections" class="nav-list"></ul>

            <button class="nav-label nav-label-library nav-section" data-target="nav-folders">Library<span class="nav-twisty">−</span></button>
            <ul id="nav-folders" class="nav-list"></ul>
        </nav>
    </aside>

    <main class="main">
        <div id="paths-alert" class="paths-alert hidden">
            <p id="paths-alert-text"></p>
            <button class="btn" id="btn-fix-now">Update paths now</button>
            <button class="btn btn-quiet" id="btn-fix-later">Later</button>
        </div>
        <div id="nautica-alert" class="paths-alert nautica-alert hidden">
            <p id="nautica-alert-text"></p>
            <button class="btn" id="btn-nautica-open">Open Nautica</button>
            <button class="btn btn-quiet" id="btn-nautica-later">Later</button>
        </div>
        <div class="context" id="context">
            <input type="checkbox" id="select-all" aria-label="Select all songs">
            <div class="context-head">
                <h2 id="context-title">&nbsp;</h2>
                <p id="context-count"></p>
            </div>
            <button class="btn btn-primary hidden" id="btn-add-selected"></button>
            <div class="context-actions hidden" id="collection-actions">
                <button class="btn btn-primary" id="btn-share">Share</button>
                <button class="btn" id="btn-rename">Rename</button>
                <button class="btn btn-danger-quiet" id="btn-delete">Delete</button>
            </div>
            <select id="sort" class="sort" aria-label="Sort by">
                <option value="title">Sort by title</option>
                <option value="artist">Sort by artist</option>
                <option value="level">Sort by level</option>
            </select>
        </div>
        <div id="songlist" class="songlist" tabindex="-1"></div>
        <div id="list-sentinel"></div>
    </main>

    <div id="player" class="player hidden">
        <button id="player-toggle" class="player-toggle" aria-label="Play / pause"></button>
        <div class="player-info">
            <p id="player-title"></p>
            <div class="player-track"><div id="player-progress"></div></div>
        </div>
        <input type="range" id="player-volume" min="0" max="100" aria-label="Volume">
        <audio id="audio"></audio>
    </div>

</div>

<div id="modal-root" class="modal-root hidden">
    <div class="modal-overlay"></div>
    <div class="modal" role="dialog" aria-modal="true"></div>
</div>

<div id="toasts" class="toasts" aria-live="polite"></div>

<script src="assets/js/lang/fr.js?v=<?= $v ?>" defer></script>
<script src="assets/js/lang/ja.js?v=<?= $v ?>" defer></script>
<script src="assets/js/lang/zh.js?v=<?= $v ?>" defer></script>
<script src="assets/js/lang/ko.js?v=<?= $v ?>" defer></script>
<script src="assets/js/app.js?v=<?= $v ?>" defer></script>
</body>
</html>
