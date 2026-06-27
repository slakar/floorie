<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const MAX_BODY_BYTES = 2097152;
const MAX_WALLS = 10000;
const MAX_LABELS = 2000;
const MAX_RULERS = 5000;
const MAX_SHAPES = 5000;
const MAX_OBJECTS = 2000;
const MAX_ELEVATION_ITEMS = 5000;

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

function valid_color($value): bool
{
    return is_string($value) && (bool) preg_match('/^#[0-9a-fA-F]{6}$/', $value);
}

function valid_shade($value): bool
{
    return finite_number($value) && $value >= 0.2 && $value <= 1;
}

function validate_plan($plan): void
{
    if (!is_array($plan) || !isset($plan['walls']) || !is_array($plan['walls'])) {
        respond(422, ['error' => 'The plan must contain a walls array.']);
    }
    if (count($plan['walls']) > MAX_WALLS) respond(422, ['error' => 'The plan contains too many walls.']);
    foreach ($plan['walls'] as $wall) {
        if (!is_array($wall) || !valid_point($wall['a'] ?? null) || !valid_point($wall['b'] ?? null)
            || (isset($wall['thickness']) && (!finite_number($wall['thickness']) || $wall['thickness'] < 3 || $wall['thickness'] > 12))
            || (isset($wall['color']) && !valid_color($wall['color']))
            || (isset($wall['shade']) && !valid_shade($wall['shade']))) {
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
    $rulers = $plan['rulers'] ?? [];
    if (!is_array($rulers) || count($rulers) > MAX_RULERS) respond(422, ['error' => 'The plan contains invalid rulers.']);
    foreach ($rulers as $ruler) {
        if (!is_array($ruler) || !valid_point($ruler['a'] ?? null) || !valid_point($ruler['b'] ?? null)) {
            respond(422, ['error' => 'The plan contains an invalid ruler.']);
        }
    }
    $shapes = $plan['shapes'] ?? [];
    if (!is_array($shapes) || count($shapes) > MAX_SHAPES) respond(422, ['error' => 'The plan contains invalid shapes.']);
    foreach ($shapes as $shape) {
        $type = is_array($shape) ? ($shape['type'] ?? '') : '';
        $linear = $type === 'square' || $type === 'rectangle' || $type === 'line';
        $radial = $type === 'circle' || $type === 'semicircle';
        if ((!$linear && !$radial)
            || ($linear && (!valid_point($shape['a'] ?? null) || !valid_point($shape['b'] ?? null)))
            || ($radial && (!valid_point($shape['center'] ?? null) || !isset($shape['radius']) || !finite_number($shape['radius']) || $shape['radius'] < 0))
            || (isset($shape['color']) && !valid_color($shape['color']))
            || (isset($shape['shade']) && !valid_shade($shape['shade']))) {
            respond(422, ['error' => 'The plan contains an invalid shape.']);
        }
    }
    $objects = $plan['objects'] ?? [];
    if (!is_array($objects) || count($objects) > MAX_OBJECTS) respond(422, ['error' => 'The plan contains invalid objects.']);
    foreach ($objects as $object) {
        $symbol = is_array($object) ? ($object['symbol'] ?? '') : '';
        if (!is_array($object) || !in_array($symbol, ['car', 'person'], true) || !valid_point($object)
            || !isset($object['width'], $object['height'])
            || !finite_number($object['width']) || !finite_number($object['height'])
            || $object['width'] <= 0 || $object['height'] <= 0) {
            respond(422, ['error' => 'The plan contains an invalid object.']);
        }
    }
    $elevations = $plan['elevations'] ?? null;
    if ($elevations !== null) {
        if (!is_array($elevations)) respond(422, ['error' => 'The plan contains invalid elevations.']);
        $views = $elevations['views'] ?? $elevations;
        if (!is_array($views)) respond(422, ['error' => 'The plan contains invalid elevations.']);
        foreach (['front', 'right', 'left', 'rear'] as $viewName) {
            $view = $views[$viewName] ?? null;
            if ($view === null) continue;
            if (!is_array($view) || (isset($view['offset']) && !valid_point($view['offset']))
                || (isset($view['zoom']) && (!finite_number($view['zoom']) || $view['zoom'] < 0.1 || $view['zoom'] > 2))
                || (isset($view['gridInches']) && (!finite_number($view['gridInches']) || !in_array((int) $view['gridInches'], [1, 3, 6, 12, 24], true)))) {
                respond(422, ['error' => 'The plan contains an invalid elevation view.']);
            }
            $items = $view['items'] ?? [];
            if (!is_array($items) || count($items) > MAX_ELEVATION_ITEMS) respond(422, ['error' => 'The plan contains invalid elevation items.']);
            foreach ($items as $item) {
                $type = is_array($item) ? ($item['type'] ?? '') : '';
                $linear = in_array($type, ['line', 'rect', 'dimension'], true);
                $text = $type === 'text';
                if ((!$linear && !$text)
                    || ($linear && (!valid_point($item['a'] ?? null) || !valid_point($item['b'] ?? null)))
                    || ($text && (!valid_point($item) || !isset($item['text']) || !is_string($item['text']) || strlen($item['text']) > 800))
                    || (isset($item['labelOffset']) && !valid_point($item['labelOffset']))
                    || (isset($item['color']) && !valid_color($item['color']))
                    || (isset($item['width']) && (!finite_number($item['width']) || $item['width'] < 1 || $item['width'] > 8))
                    || (isset($item['fontSize']) && (!finite_number($item['fontSize']) || $item['fontSize'] < 10 || $item['fontSize'] > 48))) {
                    respond(422, ['error' => 'The plan contains an invalid elevation item.']);
                }
            }
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
