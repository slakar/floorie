<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const MAX_BODY_BYTES = 2097152;
const MAX_WALLS = 10000;
const MAX_LABELS = 2000;

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function valid_id(string $id): bool
{
    return (bool) preg_match('/^[a-zA-Z0-9-]{8,64}$/', $id);
}

function finite_number($value): bool
{
    return is_int($value) || (is_float($value) && is_finite($value));
}

function valid_point($point): bool
{
    return is_array($point)
        && array_key_exists('x', $point) && finite_number($point['x'])
        && array_key_exists('y', $point) && finite_number($point['y']);
}

function validate_plan($plan): void
{
    if (!is_array($plan) || !isset($plan['walls']) || !is_array($plan['walls'])) {
        respond(422, ['error' => 'The plan must contain a walls array.']);
    }
    if (count($plan['walls']) > MAX_WALLS) respond(422, ['error' => 'The plan contains too many walls.']);
    foreach ($plan['walls'] as $wall) {
        if (!is_array($wall) || !valid_point($wall['a'] ?? null) || !valid_point($wall['b'] ?? null)) {
            respond(422, ['error' => 'The plan contains an invalid wall.']);
        }
    }
    $labels = $plan['labels'] ?? [];
    if (!is_array($labels) || count($labels) > MAX_LABELS) respond(422, ['error' => 'The plan contains invalid labels.']);
    foreach ($labels as $label) {
        if (!is_array($label) || !isset($label['text']) || !is_string($label['text'])
            || strlen($label['text']) > 800 || !valid_point($label)
            || (isset($label['fontSize']) && (!finite_number($label['fontSize']) || $label['fontSize'] < 10 || $label['fontSize'] > 48))) {
            respond(422, ['error' => 'The plan contains an invalid text label.']);
        }
    }
}

$dataDir = getenv('GRIDLINE_DATA_DIR') ?: __DIR__ . DIRECTORY_SEPARATOR . 'data';
if (!is_dir($dataDir) && !mkdir($dataDir, 0770, true) && !is_dir($dataDir)) {
    respond(500, ['error' => 'The plan storage directory could not be created.']);
}
if (!is_writable($dataDir)) respond(500, ['error' => 'The plan storage directory is not writable by PHP.']);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $id = isset($_GET['id']) ? (string) $_GET['id'] : '';
    if ($id !== '') {
        if (!valid_id($id)) respond(400, ['error' => 'Invalid plan identifier.']);
        $path = $dataDir . DIRECTORY_SEPARATOR . $id . '.json';
        if (!is_file($path)) respond(404, ['error' => 'Plan not found.']);
        $stored = json_decode((string) file_get_contents($path), true);
        if (!is_array($stored) || !isset($stored['plan'])) respond(500, ['error' => 'The stored plan is invalid.']);
        respond(200, $stored);
    }

    $plans = [];
    foreach (glob($dataDir . DIRECTORY_SEPARATOR . '*.json') ?: [] as $path) {
        $stored = json_decode((string) @file_get_contents($path), true);
        if (!is_array($stored) || !isset($stored['id'], $stored['name'], $stored['updatedAt'])) continue;
        $plans[] = ['id' => $stored['id'], 'name' => $stored['name'], 'updatedAt' => $stored['updatedAt']];
    }
    usort($plans, static function (array $a, array $b): int { return strcmp($b['updatedAt'], $a['updatedAt']); });
    respond(200, ['plans' => $plans]);
}

if ($method === 'POST') {
    $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($length > MAX_BODY_BYTES) respond(413, ['error' => 'The plan is larger than 2 MB.']);
    $raw = (string) file_get_contents('php://input');
    if (strlen($raw) > MAX_BODY_BYTES) respond(413, ['error' => 'The plan is larger than 2 MB.']);
    $input = json_decode($raw, true);
    if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) respond(400, ['error' => 'The request body must be valid JSON.']);

    $name = trim((string) ($input['name'] ?? ''));
    $name = preg_replace('/[\x00-\x1F\x7F]/u', '', $name) ?? '';
    if ($name === '') respond(422, ['error' => 'A plan name is required.']);
    $name = function_exists('mb_substr') ? mb_substr($name, 0, 100) : substr($name, 0, 100);
    validate_plan($input['plan'] ?? null);

    $requestedId = isset($input['id']) && $input['id'] !== null ? (string) $input['id'] : '';
    if ($requestedId !== '' && !valid_id($requestedId)) respond(400, ['error' => 'Invalid plan identifier.']);
    $id = $requestedId !== '' ? $requestedId : gmdate('Ymd-His') . '-' . bin2hex(random_bytes(5));
    $stored = [
        'id' => $id,
        'name' => $name,
        'updatedAt' => gmdate('c'),
        'plan' => $input['plan'],
    ];
    $json = json_encode($stored, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) respond(422, ['error' => 'The plan could not be encoded as JSON.']);

    $path = $dataDir . DIRECTORY_SEPARATOR . $id . '.json';
    $temp = $dataDir . DIRECTORY_SEPARATOR . '.' . $id . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (file_put_contents($temp, $json, LOCK_EX) === false) respond(500, ['error' => 'The plan could not be written.']);
    if (!rename($temp, $path)) { @unlink($temp); respond(500, ['error' => 'The plan could not be finalized.']); }
    respond(200, ['id' => $id, 'name' => $name, 'updatedAt' => $stored['updatedAt']]);
}

header('Allow: GET, POST');
respond(405, ['error' => 'Method not allowed.']);
