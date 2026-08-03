<?php
declare(strict_types=1);

define('APP_ROOT', dirname(__DIR__));
define('DATA_DIR', APP_ROOT . '/data');
define('BACKUP_DIR', APP_ROOT . '/backups');
define('SETTINGS_FILE', DATA_DIR . '/settings.json');

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/game.php';
require_once __DIR__ . '/songs.php';
require_once __DIR__ . '/explore.php';
require_once __DIR__ . '/collections.php';
require_once __DIR__ . '/playlist.php';
require_once __DIR__ . '/backup.php';
require_once __DIR__ . '/stats.php';
require_once __DIR__ . '/nautica.php';

// JSON_INVALID_UTF8_SUBSTITUTE: some old charts carry Shift-JIS bytes in
// their metadata — without it json_encode silently returns false and the
// response goes out empty
function jsonResponse(array $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function jsonError(string $message, int $status = 400): never
{
    jsonResponse(['error' => $message], $status);
}

function loadSettings(): array
{
    if (!is_file(SETTINGS_FILE)) {
        return [];
    }
    $raw = file_get_contents(SETTINGS_FILE);
    $data = json_decode($raw, true);

    return is_array($data) ? $data : [];
}

function saveSettings(array $settings): void
{
    if (!is_dir(DATA_DIR)) {
        mkdir(DATA_DIR, 0777, true);
    }
    file_put_contents(SETTINGS_FILE, json_encode($settings, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

// Normalize a filesystem path to forward slashes, no trailing slash
function normalizePath(string $path): string
{
    $path = str_replace('\\', '/', trim($path));

    return rtrim($path, '/');
}
