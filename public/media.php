<?php
declare(strict_types=1);

// Serves jackets and audio previews from the songs folder, wherever it is
// (any drive, outside the web root). Containment-checked, extension
// whitelisted, with HTTP Range support so audio seeking works.

require_once dirname(__DIR__) . '/src/bootstrap.php';

const MEDIA_TYPES = [
    'jpg'  => 'image/jpeg',
    'jpeg' => 'image/jpeg',
    'png'  => 'image/png',
    'gif'  => 'image/gif',
    'webp' => 'image/webp',
    'bmp'  => 'image/bmp',
    'ogg'  => 'audio/ogg',
    'mp3'  => 'audio/mpeg',
    'wav'  => 'audio/wav',
    'flac' => 'audio/flac',
    'opus' => 'audio/ogg',
];

$relative = (string) ($_GET['f'] ?? '');
if ($relative === '') {
    http_response_code(400);
    exit('missing f parameter');
}

$paths = gamePaths();
if ($paths['songs_root'] === null) {
    http_response_code(409);
    exit('songs folder not configured');
}

$file = realpath($paths['songs_root'] . '/' . $relative);
$root = realpath($paths['songs_root']);
if ($file === false || $root === false || !str_starts_with($file, $root . DIRECTORY_SEPARATOR)) {
    http_response_code(404);
    exit('not found');
}

$ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
if (!isset(MEDIA_TYPES[$ext])) {
    http_response_code(403);
    exit('file type not allowed');
}

$size = filesize($file);
$mime = MEDIA_TYPES[$ext];

header('Content-Type: ' . $mime);
header('Accept-Ranges: bytes');
header('Cache-Control: public, max-age=86400');

// Single-range support (enough for <audio> seeking)
$start = 0;
$end = $size - 1;
if (isset($_SERVER['HTTP_RANGE']) && preg_match('/bytes=(\d*)-(\d*)/', $_SERVER['HTTP_RANGE'], $m)) {
    if ($m[1] !== '') {
        $start = (int) $m[1];
    }
    if ($m[2] !== '') {
        $end = min((int) $m[2], $size - 1);
    }
    if ($m[1] === '' && $m[2] !== '') { // suffix range: last N bytes
        $start = max(0, $size - (int) $m[2]);
        $end = $size - 1;
    }
    if ($start > $end || $start >= $size) {
        http_response_code(416);
        header('Content-Range: bytes */' . $size);
        exit;
    }
    http_response_code(206);
    header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
}

header('Content-Length: ' . ($end - $start + 1));

$fp = fopen($file, 'rb');
fseek($fp, $start);
$remaining = $end - $start + 1;
while ($remaining > 0 && !feof($fp)) {
    $chunk = fread($fp, min(65536, $remaining));
    echo $chunk;
    $remaining -= strlen($chunk);
}
fclose($fp);
