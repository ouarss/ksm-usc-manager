<?php
declare(strict_types=1);

// Nautica (ksm.dev) integration — the community chart repository.
// Activation, download folder and meta-file location live in data/settings.json
// (nautica key). The sync state itself (last_seen, downloaded ids, daily check)
// is our meta.json — kept by default in the songs folder so it travels with the
// library and stays close to the old nautica-downloader's own meta.json. The
// location is user-adjustable in Settings.

const NAUTICA_API = 'https://ksm.dev/app/songs';

function nauticaSettings(): array
{
    $nautica = loadSettings()['nautica'] ?? [];

    return [
        'enabled' => (bool) ($nautica['enabled'] ?? false),
        'dir'     => $nautica['dir'] ?? null,
        'meta'    => $nautica['meta'] ?? null,
    ];
}

// Where the sync state is stored. Configured path, else the tool's data/
// folder as a pre-configuration fallback.
function nauticaStateFile(): string
{
    return nauticaSettings()['meta'] ?: DATA_DIR . '/nautica.json';
}

function nauticaStateLoad(): array
{
    $file = nauticaStateFile();
    $data = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;

    return is_array($data) ? $data : ['last_seen' => null, 'last_check' => 0, 'new_count' => 0, 'downloaded' => []];
}

function nauticaStateSave(array $state): void
{
    $file = nauticaStateFile();
    $dir = dirname($file);
    if (!is_dir($dir)) {
        mkdir($dir, 0777, true);
    }
    file_put_contents($file, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

// Give a settings-less install a meta location (default <songs>/meta.json) and
// migrate any state that still lives in the old data/ file to it.
function nauticaEnsureMeta(string $songsRoot): void
{
    $settings = loadSettings();
    if (empty($settings['nautica']['enabled']) || !empty($settings['nautica']['meta'])) {
        return;
    }

    $existing = nauticaStateLoad(); // reads the data/ fallback
    $settings['nautica']['meta'] = normalizePath($songsRoot) . '/meta.json';
    saveSettings($settings);
    if (!is_file($settings['nautica']['meta'])) {
        nauticaStateSave($existing); // seed the new location
    }
}

// What the front needs to know
function nauticaPublicState(): array
{
    $settings = nauticaSettings();
    $state = nauticaStateLoad();

    return [
        'enabled'   => $settings['enabled'],
        'dir'       => $settings['dir'],
        'meta'      => nauticaStateFile(),
        'new_count' => (int) ($state['new_count'] ?? 0),
        'last_seen' => $state['last_seen'] ?? null,
    ];
}

function nauticaHttp(string $url, int $timeout = 8): array
{
    $context = stream_context_create(['http' => [
        'timeout' => $timeout,
        'ignore_errors' => true,
        'header' => "User-Agent: usc-manager\r\n",
    ]]);
    $raw = @file_get_contents($url, false, $context);
    if ($raw === false) {
        throw new RuntimeException('Nautica (ksm.dev) is unreachable');
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new RuntimeException('Unexpected answer from Nautica');
    }

    return $data;
}

// Enable requires a dedicated folder INSIDE the songs folder — otherwise the
// game would never index the downloads. First activation baselines "new"
// to the newest published chart so sync never mass-downloads the backlog.
// $metaPath is where the sync state is kept (default <songs>/meta.json);
// changing it migrates the existing state to the new location.
function nauticaEnable(bool $enabled, string $dir, string $songsRoot, string $metaPath = ''): void
{
    $settings = loadSettings();

    if (!$enabled) {
        $settings['nautica'] = [
            'enabled' => false,
            'dir'     => $settings['nautica']['dir'] ?? null,
            'meta'    => $settings['nautica']['meta'] ?? null,
        ];
        saveSettings($settings);

        return;
    }

    $dir = normalizePath($dir);
    if ($dir === '') {
        throw new RuntimeException('A download folder is required to enable Nautica');
    }
    if (!str_starts_with(mb_strtolower($dir . '/'), mb_strtolower(rtrim($songsRoot, '/') . '/'))) {
        throw new RuntimeException('The Nautica folder must be inside your songs folder (e.g. ' . $songsRoot . '/nautica), or the game will never index the downloads');
    }
    if (!is_dir($dir) && !@mkdir($dir, 0777, true)) {
        throw new RuntimeException('Cannot create folder: ' . $dir);
    }

    $meta = normalizePath($metaPath);
    if ($meta === '') {
        $meta = normalizePath($songsRoot) . '/meta.json';
    }

    // Carry the current state to the (possibly new) meta location before the
    // settings switch changes where load/save point
    $existing = nauticaStateLoad();
    $settings['nautica'] = ['enabled' => true, 'dir' => $dir, 'meta' => $meta];
    saveSettings($settings);
    if (!is_file($meta)) {
        nauticaStateSave($existing);
    }

    nauticaImportLegacy($dir, $songsRoot);

    $state = nauticaStateLoad();
    if (empty($state['last_seen'])) {
        try {
            $data = nauticaHttp(NAUTICA_API . '?sort=uploaded', 6);
            $state['last_seen'] = $data['data'][0]['uploaded_at'] ?? date('Y-m-d H:i:s');
        } catch (Throwable) {
            $state['last_seen'] = date('Y-m-d H:i:s');
        }
        $state['new_count'] = 0;
        $state['last_check'] = time();
        nauticaStateSave($state);
    }
}

// The original nautica-downloader.exe leaves a meta.json in the songs/nautica
// folder listing every chart it ever downloaded (songDownloadTimes: id=>time).
// Import it once so those charts aren't offered for re-download. Runs on the
// current download folder and, as a fallback, on <songs>/nautica.
function nauticaImportLegacy(string $dir, string $songsRoot): int
{
    $state = nauticaStateLoad();
    if (!empty($state['legacy_imported'])) {
        return 0;
    }

    $candidates = array_unique([$dir . '/meta.json', $songsRoot . '/nautica/meta.json']);
    $imported = 0;
    foreach ($candidates as $meta) {
        if (!is_file($meta)) {
            continue;
        }
        $data = json_decode((string) file_get_contents($meta), true);
        foreach (array_keys($data['songDownloadTimes'] ?? []) as $id) {
            if (!isset($state['downloaded'][$id])) {
                $state['downloaded'][$id] = 'legacy';
                $imported++;
            }
        }
    }

    $state['legacy_imported'] = true;
    nauticaStateSave($state);

    return $imported;
}

// Once a day at startup: peek at the first page and count charts newer
// than last_seen. Failures are silent (offline should not break the app).
function nauticaDailyCheck(): array
{
    $state = nauticaStateLoad();
    if (!nauticaSettings()['enabled'] || time() - (int) ($state['last_check'] ?? 0) < 86400) {
        return $state;
    }

    try {
        $data = nauticaHttp(NAUTICA_API . '?sort=uploaded', 6);
        $count = 0;
        foreach ($data['data'] ?? [] as $song) {
            if ($state['last_seen'] === null || ($song['uploaded_at'] ?? '') > $state['last_seen']) {
                $count++;
            }
        }
        $state['new_count'] = $count;
    } catch (Throwable) {
        // keep the previous count, retry tomorrow
    }
    $state['last_check'] = time();
    nauticaStateSave($state);

    return $state;
}

// Proxy one API page (avoids CORS), annotated with local knowledge.
// A text query searches title/artist (?q=) AND effector (?effector=),
// merged — the API keeps them separate.
function nauticaList(int $page, string $query): array
{
    $base = NAUTICA_API . '?sort=uploaded&page=' . max(1, $page);
    $data = nauticaHttp($base . ($query !== '' ? '&q=' . rawurlencode($query) : ''), 10);
    $rows = $data['data'] ?? [];
    $hasNext = !empty($data['links']['next']);

    if ($query !== '') {
        try {
            $byEffector = nauticaHttp($base . '&effector=' . rawurlencode($query), 10);
            $seen = array_flip(array_column($rows, 'id'));
            foreach ($byEffector['data'] ?? [] as $song) {
                if (!isset($seen[$song['id']])) {
                    $rows[] = $song;
                }
            }
            $hasNext = $hasNext || !empty($byEffector['links']['next']);
        } catch (Throwable) {
            // effector search is best-effort
        }
    }

    $state = nauticaStateLoad();

    $songs = [];
    foreach ($rows as $song) {
        // Effectors, one per difficulty; distinct names joined for display
        $effectors = array_values(array_unique(array_filter(array_map(
            fn(array $c) => trim((string) ($c['effector'] ?? '')),
            $song['charts'] ?? []
        ))));

        $songs[] = [
            'id'          => $song['id'],
            'title'       => $song['title'],
            'artist'      => $song['artist'],
            'effector'    => implode(', ', $effectors),
            'jacket'      => $song['jacket_url'] ?? null,
            'preview'     => !empty($song['has_preview']) ? ($song['preview_url'] ?? null) : null,
            'uploaded_at' => $song['uploaded_at'] ?? '',
            'downloads'   => (int) ($song['downloads'] ?? 0),
            'charts'      => array_map(
                fn(array $c) => ['diff' => (int) ($c['difficulty'] ?? 0), 'level' => (int) ($c['level'] ?? 0)],
                $song['charts'] ?? []
            ),
            'installed'   => isset($state['downloaded'][$song['id']]),
            'is_new'      => $state['last_seen'] !== null && ($song['uploaded_at'] ?? '') > $state['last_seen'],
        ];
    }

    return ['songs' => $songs, 'page' => max(1, $page), 'has_next' => $hasNext];
}

// The download happens in two visible steps: fetch (zip from the CDN into
// data/nautica-tmp/) then extract (into the Nautica folder). The UI shows
// each step and a failed song never aborts a whole sync run.

function nauticaTmpBase(string $id): string
{
    return DATA_DIR . '/nautica-tmp/' . preg_replace('/[^a-z0-9-]/i', '', $id);
}

// The CDN url carries a raw, unencoded filename (spaces, Japanese…). Only
// the last path segment must be percent-encoded; the rest is already valid.
function encodeCdnUrl(string $url): string
{
    $cut = strrpos($url, '/');
    if ($cut === false) {
        return $url;
    }

    return substr($url, 0, $cut + 1) . rawurlencode(substr($url, $cut + 1));
}

function nauticaFetch(string $id): array
{
    $info = nauticaHttp(NAUTICA_API . '/' . rawurlencode($id), 15);
    $song = $info['data'] ?? [];
    $url = $song['cdn_download_url'] ?? null;
    $title = (string) ($song['title'] ?? $id);
    if (!$url) {
        throw new RuntimeException('No download link for this song');
    }

    set_time_limit(0);
    $base = nauticaTmpBase($id);
    if (!is_dir(dirname($base))) {
        mkdir(dirname($base), 0777, true);
    }

    $fp = fopen($base . '.zip', 'wb');
    $ch = curl_init(encodeCdnUrl($url));
    curl_setopt_array($ch, [
        CURLOPT_FILE           => $fp,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT        => 300,
        CURLOPT_USERAGENT      => 'usc-manager',
        CURLOPT_FAILONERROR    => true,
    ]);
    $ok = curl_exec($ch);
    $error = curl_error($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    fclose($fp);

    if (!$ok) {
        @unlink($base . '.zip');
        throw new RuntimeException('Download failed — ' . ($error !== '' ? $error : 'HTTP ' . $status));
    }
    file_put_contents($base . '.json', json_encode(['title' => $title], JSON_UNESCAPED_UNICODE));

    return ['size' => filesize($base . '.zip'), 'title' => $title];
}

function nauticaExtract(string $id, string $dir): array
{
    $base = nauticaTmpBase($id);
    $tmp = $base . '.zip';
    if (!is_file($tmp)) {
        throw new RuntimeException('Nothing fetched for this song — run the download again');
    }
    $meta = json_decode((string) @file_get_contents($base . '.json'), true) ?: [];
    $title = (string) ($meta['title'] ?? $id);
    $cleanup = function () use ($base) {
        @unlink($base . '.zip');
        @unlink($base . '.json');
    };

    $zip = new ZipArchive();
    if ($zip->open($tmp) !== true) {
        $cleanup();
        throw new RuntimeException('Corrupted archive');
    }

    // Single top-level folder -> extract as-is; loose files -> wrap them
    // in a folder named after the song
    $roots = [];
    $hasFolders = false;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = str_replace('\\', '/', (string) $zip->getNameIndex($i));
        $roots[explode('/', $name)[0]] = true;
        if (str_contains($name, '/')) {
            $hasFolders = true;
        }
    }
    $files = $zip->numFiles;

    if (count($roots) === 1 && $hasFolders) {
        $folder = (string) array_key_first($roots);
        $target = $dir;
    } else {
        $folder = favFilenameFor(trim($title));
        $target = $dir . '/' . $folder;
        if (!is_dir($target) && !@mkdir($target, 0777, true)) {
            $zip->close();
            $cleanup();
            throw new RuntimeException('Cannot create folder: ' . $target);
        }
    }

    $extracted = $zip->extractTo($target);
    $zip->close();
    $cleanup();
    if (!$extracted) {
        throw new RuntimeException('Extraction failed (a file name may be invalid on Windows)');
    }

    $state = nauticaStateLoad();
    $state['downloaded'][$id] = $folder;
    nauticaStateSave($state);

    return ['folder' => $folder, 'title' => $title, 'files' => $files];
}

// Called when a sync completes (or the banner is dismissed): everything
// up to $date is no longer "new"
function nauticaMarkSeen(string $date): array
{
    $state = nauticaStateLoad();
    if ($date !== '' && ($state['last_seen'] === null || $date > $state['last_seen'])) {
        $state['last_seen'] = $date;
    }
    $state['new_count'] = 0;
    $state['last_check'] = time();
    nauticaStateSave($state);

    return $state;
}
