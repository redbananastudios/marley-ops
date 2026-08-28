<?php
/**
 * Plugin Name: Pitmans Lead Bridge
 * Description: Persists every quote-form submission to a local table, pushes it to Marley Ops the moment it arrives, and exposes a signed read endpoint so Ops can poll for anything the push missed. Persist-first by design — the push is allowed to fail; the local row plus the Ops pull rail are what stop an enquiry being lost silently.
 * Version: 1.0.0
 * Requires PHP: 7.4
 * Author: Red Banana Studios
 * License: Proprietary
 *
 * WHY THIS SHAPE (docs/multi-brand-prd.md §3.8 in the marley-ops repo):
 * a push-only integration loses enquiries silently — the failure leaves no
 * trace on either side, and the surface that would have shown the gap is the
 * one the failure just emptied. So every submission is written to a dedicated
 * table FIRST (that write must succeed even when the push fails), and Ops
 * polls a signed read endpoint over a disjoint channel to reconcile. The
 * plugin without the pull rail configured on the Ops side is a silent-loss
 * configuration — see README.md.
 *
 * The form stack is Contact Form 7 (hook: wpcf7_before_send_mail), but every CF7
 * specific — form ids, field names — is CONFIG, not code, so a form rebuild
 * or a different form plugin means editing config.php, not this file.
 *
 * PHP 7.4-compatible on purpose: typical WP hosting. No enums, no match, no
 * constructor promotion, no readonly.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('PLB_VERSION', '1.0.0');
define('PLB_DB_VERSION', '1');
define('PLB_TABLE', 'plb_submissions');

/**
 * The external-id contract, shared with the Ops pull rail — keep the two in
 * step or reconciliation breaks (marley-ops lib/sync/wp-leads.ts holds the
 * other half; README.md "The id contract" is the spec):
 *
 *   external_lead_id = 'wp-' + row id zero-padded to 6 digits  → 'wp-000042'
 *
 * The padding is not cosmetic: the Ops ingest schema requires ids of at least
 * 8 characters, and 'wp-1' is four. Ids past 999999 simply grow longer.
 */
function plb_external_lead_id($row_id) {
    return 'wp-' . str_pad((string) (int) $row_id, 6, '0', STR_PAD_LEFT);
}

/** Fully-qualified table name. */
function plb_table() {
    global $wpdb;
    return $wpdb->prefix . PLB_TABLE;
}

/**
 * Load config.php once. Returns null (and the plugin stays inert, loudly —
 * see the admin notice) when the file is missing or still holds placeholder
 * secrets. Secrets are never echoed anywhere; only their presence is checked.
 */
function plb_config() {
    static $config = null;
    static $loaded = false;
    if ($loaded) {
        return $config;
    }
    $loaded = true;

    $path = __DIR__ . '/config.php';
    if (!file_exists($path)) {
        return null;
    }
    $raw = include $path;
    if (!is_array($raw)) {
        return null;
    }

    $defaults = array(
        'form_ids'          => array(),
        'ops_ingest_url'    => 'https://ops.marleymoves.co.uk/api/ingest/lead',
        'ops_ingest_secret' => '',
        'pull_secret'       => '',
        'field_map'         => array(),
        'source_prefix'     => 'wp_cf7',
    );
    $cfg = array_merge($defaults, $raw);

    // A placeholder or too-short secret is treated as absent: pushing with it
    // would 401 forever, and accepting signed reads against it would make the
    // pull rail forgeable. Fail closed, say so in wp-admin.
    foreach (array('ops_ingest_secret', 'pull_secret') as $key) {
        $value = is_string($cfg[$key]) ? trim($cfg[$key]) : '';
        if (strlen($value) < 16 || strpos($value, 'CHANGE-ME') !== false) {
            $cfg[$key] = '';
        } else {
            $cfg[$key] = $value;
        }
    }
    $cfg['form_ids'] = array_map('intval', (array) $cfg['form_ids']);

    $config = $cfg;
    return $config;
}

/**
 * Create/upgrade the submissions table. dbDelta is idempotent, so this runs on
 * activation AND on version bumps (admin_init check below).
 *
 * The columns mirror what the pull rail needs to reason about delivery:
 * pushed_at IS NULL means "Ops has not acknowledged this over the push
 * channel" — the pull rail treats those as candidates, and a row that pushed
 * fine is still returned so Ops can verify rather than trust.
 */
function plb_install_table() {
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';

    $table   = plb_table();
    $charset = $wpdb->get_charset_collate();

    $sql = "CREATE TABLE {$table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        form_id BIGINT UNSIGNED NOT NULL,
        submitted_at DATETIME NOT NULL,
        payload LONGTEXT NOT NULL,
        pushed_at DATETIME NULL DEFAULT NULL,
        push_attempts INT UNSIGNED NOT NULL DEFAULT 0,
        last_error TEXT NULL,
        PRIMARY KEY  (id),
        KEY pushed_at (pushed_at)
    ) {$charset};";

    dbDelta($sql);
    update_option('plb_db_version', PLB_DB_VERSION);
}
register_activation_hook(__FILE__, 'plb_install_table');

add_action('admin_init', function () {
    if (get_option('plb_db_version') !== PLB_DB_VERSION) {
        plb_install_table();
    }
});

/** Loud in wp-admin when the plugin cannot do its job — never silently inert. */
add_action('admin_notices', function () {
    if (!current_user_can('manage_options')) {
        return;
    }
    $cfg = plb_config();
    if ($cfg === null) {
        echo '<div class="notice notice-error"><p><strong>Pitmans Lead Bridge:</strong> '
            . esc_html__('config.php is missing. Copy config-sample.php to config.php and fill it in — until then NO submissions are being captured or pushed to Ops.', 'pitmans-lead-bridge')
            . '</p></div>';
        return;
    }
    if ($cfg['ops_ingest_secret'] === '' || $cfg['pull_secret'] === '') {
        echo '<div class="notice notice-error"><p><strong>Pitmans Lead Bridge:</strong> '
            . esc_html__('one or both secrets in config.php are missing or placeholders. Submissions are being captured locally but cannot be pushed to Ops, and Ops cannot poll for them.', 'pitmans-lead-bridge')
            . '</p></div>';
    }
    if (empty($cfg['form_ids'])) {
        echo '<div class="notice notice-warning"><p><strong>Pitmans Lead Bridge:</strong> '
            . esc_html__('no form_ids configured in config.php — the bridge is not listening to any form.', 'pitmans-lead-bridge')
            . '</p></div>';
    }
});

/**
 * Take a CF7 posted-data array and return only what we are willing to store:
 * scalars and arrays of scalars, internal _wpcf7* fields stripped, values
 * sanitised and length-capped. Arrays (radio/checkbox) flatten to a comma
 * list, matching how CF7 renders them into mail.
 */
function plb_clean_posted_data($posted) {
    $clean = array();
    if (!is_array($posted)) {
        return $clean;
    }
    foreach ($posted as $key => $value) {
        $key = (string) $key;
        if ($key === '' || strpos($key, '_wpcf7') === 0 || strpos($key, '_') === 0) {
            continue;
        }
        if (is_array($value)) {
            $parts = array();
            foreach ($value as $item) {
                if (is_scalar($item)) {
                    $parts[] = sanitize_text_field((string) $item);
                }
            }
            $value = implode(', ', $parts);
        } elseif (is_scalar($value)) {
            $value = sanitize_textarea_field((string) $value);
        } else {
            continue;
        }
        $clean[sanitize_key($key)] = mb_substr($value, 0, 5000);
    }
    return $clean;
}

/** First non-empty posted value among the configured field names, or ''. */
function plb_pick($clean, $names) {
    foreach ((array) $names as $name) {
        $name = sanitize_key((string) $name);
        if ($name !== '' && isset($clean[$name]) && trim($clean[$name]) !== '') {
            return trim($clean[$name]);
        }
    }
    return '';
}

/** Cap a string; return null for empty so '' never travels to Ops columns. */
function plb_cap($value, $max) {
    $value = trim((string) $value);
    if ($value === '') {
        return null;
    }
    return mb_substr($value, 0, $max);
}

/**
 * Map raw form fields to the Ops ingest contract (marley-ops
 * lib/leads/ingest.ts — websiteLeadIngestSchema). The length caps mirror that
 * schema so a long value is truncated here rather than rejected there.
 *
 * DELIBERATELY EXCLUDES leadId: the id derives from the row id, which does not
 * exist yet when this runs. Both the pusher and the Ops pull rail derive it
 * via the shared contract (plb_external_lead_id / wpExternalLeadId).
 *
 * Everything the customer typed that has no mapped home lands in notes, so a
 * form field added later is carried as text rather than dropped.
 */
function plb_build_ingest_fields($form_id, $clean, $cfg, $submitted_at_utc) {
    $map = is_array($cfg['field_map']) ? $cfg['field_map'] : array();
    $get = function ($role) use ($clean, $map) {
        return isset($map[$role]) ? plb_pick($clean, $map[$role]) : '';
    };

    $notes_lines = array();
    $from_address = $get('from_address');
    $to_address   = $get('to_address');
    $load_type    = $get('load_type');
    if ($from_address !== '') {
        $notes_lines[] = 'Moving from: ' . $from_address;
    }
    if ($to_address !== '') {
        $notes_lines[] = 'Moving to: ' . $to_address;
    }
    if ($load_type !== '') {
        $notes_lines[] = 'Load: ' . $load_type;
    }
    $customer_notes = $get('notes');
    if ($customer_notes !== '') {
        $notes_lines[] = $customer_notes;
    }

    // Unmapped leftovers, labelled, so nothing typed is silently lost.
    $mapped_names = array();
    foreach ($map as $names) {
        foreach ((array) $names as $name) {
            $mapped_names[sanitize_key((string) $name)] = true;
        }
    }
    foreach ($clean as $key => $value) {
        if (!isset($mapped_names[$key]) && trim($value) !== '') {
            $notes_lines[] = $key . ': ' . $value;
        }
    }

    $fields = array(
        'name'          => plb_cap($get('name'), 200),
        'phone'         => plb_cap($get('phone'), 50),
        'email'         => plb_cap($get('email'), 320),
        'fromPostcode'  => plb_cap($get('from_postcode'), 20),
        'toPostcode'    => plb_cap($get('to_postcode'), 20),
        'propertySize'  => plb_cap($get('property_size'), 120),
        'preferredDate' => plb_cap($get('preferred_date'), 120),
        'notes'         => plb_cap(implode("\n", $notes_lines), 5000),
        // Which form produced it, not the marketing source.
        'source'        => plb_cap($cfg['source_prefix'] . '_' . $form_id, 200),
        // "Where did you hear about us?" → leads.referrer_answer in Ops.
        'referrer'      => plb_cap($get('referrer'), 200),
        'submittedAt'   => $submitted_at_utc,
    );

    // Strip nulls: the Ops schema treats absent and null alike, and a smaller
    // payload is a smaller stored row.
    return array_filter($fields, function ($v) {
        return $v !== null;
    });
}

/**
 * STEP 1 — persist. Runs before any network call and must succeed on its own:
 * this row is the record the pull rail reconciles from, so a dead Ops box, a
 * wrong secret or a TLS failure costs latency, never the lead.
 *
 * Returns the new row id, or 0 on failure (logged — nothing else we can do
 * inside a customer's form submission without breaking their experience).
 */
function plb_persist_submission($form_id, $clean, $cfg) {
    global $wpdb;

    $now_utc = gmdate('Y-m-d H:i:s');
    $payload = array(
        'ingest' => plb_build_ingest_fields($form_id, $clean, $cfg, gmdate('Y-m-d\TH:i:s\Z')),
        'raw'    => $clean,
    );

    $ok = $wpdb->insert(
        plb_table(),
        array(
            'form_id'       => (int) $form_id,
            'submitted_at'  => $now_utc,
            'payload'       => wp_json_encode($payload),
            'push_attempts' => 0,
        ),
        array('%d', '%s', '%s', '%d')
    );
    if ($ok === false) {
        error_log('[pitmans-lead-bridge] FAILED to persist submission for form ' . $form_id . ': ' . $wpdb->last_error);
        return 0;
    }
    return (int) $wpdb->insert_id;
}

/**
 * STEP 2 — push one stored row to the Ops ingest endpoint. Best-effort:
 * failure is recorded ON the row (pushed_at stays NULL, last_error explains)
 * and the pull rail picks it up. A 400 is marked permanent — the payload will
 * never be accepted (e.g. no phone AND no email), so re-pushing it forever
 * would be noise; the pull rail still surfaces it to a human on the Ops side.
 */
function plb_push_row($row_id) {
    global $wpdb;
    $cfg = plb_config();
    if ($cfg === null || $cfg['ops_ingest_secret'] === '') {
        return false;
    }

    $table = plb_table();
    $row   = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table} WHERE id = %d", $row_id), ARRAY_A);
    if (!$row || $row['pushed_at'] !== null) {
        return (bool) ($row && $row['pushed_at'] !== null);
    }

    $payload = json_decode((string) $row['payload'], true);
    $ingest  = is_array($payload) && isset($payload['ingest']) && is_array($payload['ingest'])
        ? $payload['ingest']
        : array();
    $ingest['leadId'] = plb_external_lead_id($row['id']);

    $response = wp_remote_post($cfg['ops_ingest_url'], array(
        'timeout'  => 5,
        'headers'  => array(
            'Authorization' => 'Bearer ' . $cfg['ops_ingest_secret'],
            'Content-Type'  => 'application/json',
        ),
        'body'     => wp_json_encode($ingest),
    ));

    $attempts = ((int) $row['push_attempts']) + 1;

    if (is_wp_error($response)) {
        $wpdb->update(
            $table,
            array('push_attempts' => $attempts, 'last_error' => mb_substr($response->get_error_message(), 0, 1000)),
            array('id' => $row['id']),
            array('%d', '%s'),
            array('%d')
        );
        return false;
    }

    $code = (int) wp_remote_retrieve_response_code($response);
    if ($code >= 200 && $code < 300) {
        $wpdb->update(
            $table,
            array('pushed_at' => gmdate('Y-m-d H:i:s'), 'push_attempts' => $attempts, 'last_error' => null),
            array('id' => $row['id']),
            array('%s', '%d', '%s'),
            array('%d')
        );
        return true;
    }

    // The response body is Ops's own diagnostic ("invalid_payload: ...") —
    // keep the first line for the row. NEVER log the request (it carries the
    // secret header).
    $body   = mb_substr(trim((string) wp_remote_retrieve_body($response)), 0, 500);
    $prefix = ($code === 400) ? 'permanent: ' : '';
    $wpdb->update(
        $table,
        array('push_attempts' => $attempts, 'last_error' => mb_substr($prefix . 'HTTP ' . $code . ' ' . $body, 0, 1000)),
        array('id' => $row['id']),
        array('%d', '%s'),
        array('%d')
    );
    return false;
}

/**
 * Retry sweep — at most ONE older unpushed row per new submission, because
 * this runs inside a customer's form submit and their wait matters more than
 * our backlog. There is deliberately NO wp-cron here: wp-cron only fires on
 * traffic, which makes it a second silent-loss channel; the Ops pull rail
 * (every 15 minutes, on Ops's own clock) is the real drain for stragglers.
 * Rows marked permanent or with 10+ attempts are left to the pull rail.
 */
function plb_retry_one_unpushed($exclude_id) {
    global $wpdb;
    $table = plb_table();
    $row   = $wpdb->get_row($wpdb->prepare(
        "SELECT id FROM {$table}
         WHERE pushed_at IS NULL
           AND id != %d
           AND push_attempts < 10
           AND (last_error IS NULL OR last_error NOT LIKE %s)
         ORDER BY id ASC
         LIMIT 1",
        $exclude_id,
        $wpdb->esc_like('permanent:') . '%'
    ), ARRAY_A);
    if ($row) {
        plb_push_row((int) $row['id']);
    }
}

/**
 * The form hook. Fires for every VALIDATED, non-spam submission to a configured
 * form. Persist first, push second, then sweep one straggler. Nothing here may
 * break the customer's submission — every failure is swallowed into the row
 * or the error log.
 *
 * MUST stay on wpcf7_before_send_mail, NOT wpcf7_mail_sent. `wpcf7_mail_sent`
 * fires only when CF7's notification mail succeeded, which would make the
 * persist-first guarantee this whole design rests on conditional on the very
 * channel it exists to back up: an SMTP outage (routine on shared WP hosting)
 * would mean no row written, nothing to push, nothing for the pull rail to
 * return, and no notification email either — the enquiry destroyed with zero
 * trace on either side, while the Ops-side poll still reports a clean run.
 * `wpcf7_before_send_mail` runs after validation and the spam check but before
 * the mail attempt, so a genuine submission is always recorded.
 */
function plb_on_submission($contact_form) {
    $cfg = plb_config();
    if ($cfg === null) {
        return;
    }
    $form_id = (int) $contact_form->id();
    if (!in_array($form_id, $cfg['form_ids'], true)) {
        return;
    }
    if (!class_exists('WPCF7_Submission')) {
        return;
    }
    $submission = WPCF7_Submission::get_instance();
    if (!$submission) {
        return;
    }

    $clean = plb_clean_posted_data($submission->get_posted_data());
    if (empty($clean)) {
        return;
    }

    $row_id = plb_persist_submission($form_id, $clean, $cfg);
    if ($row_id === 0) {
        return;
    }
    plb_push_row($row_id);
    plb_retry_one_unpushed($row_id);
}
add_action('wpcf7_before_send_mail', 'plb_on_submission');

/**
 * The signed READ endpoint — the disjoint channel Ops polls.
 *
 *   GET /wp-json/pitmans-lead-bridge/v1/submissions?limit=<n>&ts=<unix>&sig=<hex>
 *
 * sig = HMAC-SHA256 over the exact string "limit=<n>&ts=<unix>" (integers,
 * no padding, that parameter order) with the pull secret. ts must be within
 * ±300 seconds of server time — a bounded replay window on a read-only
 * endpoint. The Ops side of this contract is marley-ops
 * lib/sync/wp-leads.ts:signPullQuery — change both together or not at all.
 */
add_action('rest_api_init', function () {
    register_rest_route('pitmans-lead-bridge/v1', '/submissions', array(
        'methods'             => 'GET',
        'callback'            => 'plb_rest_submissions',
        'permission_callback' => 'plb_rest_permission',
    ));
});

function plb_rest_permission($request) {
    $cfg = plb_config();
    // No configured pull secret = nothing can authenticate. Fail closed;
    // never treat "unconfigured" as "open".
    if ($cfg === null || $cfg['pull_secret'] === '') {
        return new WP_Error('plb_unconfigured', 'Not available.', array('status' => 503));
    }

    $limit    = $request->get_param('limit');
    $since_id = $request->get_param('since_id');
    $ts       = $request->get_param('ts');
    $sig      = $request->get_param('sig');

    if (!is_string($sig) || !preg_match('/^[0-9a-f]{64}$/', $sig)) {
        return new WP_Error('plb_forbidden', 'Forbidden.', array('status' => 403));
    }
    if (!is_numeric($limit) || !is_numeric($ts) || !is_numeric($since_id)) {
        return new WP_Error('plb_forbidden', 'Forbidden.', array('status' => 403));
    }
    $limit    = (int) $limit;
    $since_id = (int) $since_id;
    $ts       = (int) $ts;
    if ($limit < 1 || $limit > 500 || $since_id < 0) {
        return new WP_Error('plb_forbidden', 'Forbidden.', array('status' => 403));
    }
    if (abs(time() - $ts) > 300) {
        return new WP_Error('plb_forbidden', 'Forbidden.', array('status' => 403));
    }

    // since_id is INSIDE the signature, and REQUIRED rather than defaulted.
    // Signed, because an on-path observer must not be able to advance the
    // reader's window: a replay with since_id bumped past a row would hide that
    // row from the only backstop the enquiry has. Required, because an unsigned
    // optional parameter lets a caller that FORGOT it read exactly like a caller
    // that meant 0.
    $canonical = 'limit=' . $limit . '&since_id=' . $since_id . '&ts=' . $ts;
    $expected  = hash_hmac('sha256', $canonical, $cfg['pull_secret']);
    if (!hash_equals($expected, $sig)) {
        return new WP_Error('plb_forbidden', 'Forbidden.', array('status' => 403));
    }
    return true;
}

function plb_rest_submissions($request) {
    global $wpdb;
    $limit    = (int) $request->get_param('limit');
    $since_id = (int) $request->get_param('since_id');
    $table    = plb_table();

    // Forward from the reader's cursor, OLDEST first - not 'the newest N'. A
    // window anchored to the newest row lets anything that falls behind it leave
    // the only backstop for good, and the reader cannot even tell it happened.
    // Anchored to what the reader has actually reconciled, a row stays in view
    // until it is accounted for.
    $rows = $wpdb->get_results($wpdb->prepare(
        "SELECT id, form_id, submitted_at, payload, pushed_at, push_attempts, last_error
         FROM {$table}
         WHERE id > %d
         ORDER BY id ASC
         LIMIT %d",
        $since_id,
        $limit
    ), ARRAY_A);

    $out = array();
    foreach ((array) $rows as $row) {
        $payload = json_decode((string) $row['payload'], true);
        $out[] = array(
            'id'            => (int) $row['id'],
            'form_id'       => (int) $row['form_id'],
            // Stored as UTC DATETIME; rendered as ISO so the reader never
            // has to guess the timezone.
            'submitted_at'  => gmdate('Y-m-d\TH:i:s\Z', strtotime($row['submitted_at'] . ' UTC')),
            'pushed_at'     => $row['pushed_at'] !== null
                ? gmdate('Y-m-d\TH:i:s\Z', strtotime($row['pushed_at'] . ' UTC'))
                : null,
            'push_attempts' => (int) $row['push_attempts'],
            'last_error'    => $row['last_error'] !== null ? (string) $row['last_error'] : null,
            'payload'       => is_array($payload) ? $payload : array(),
        );
    }

    // The whole-table count, so the reader can PROVE nothing is missing rather
    // than infer it from a window that by construction cannot show what it
    // excluded. `remaining` is what this page did not reach.
    $total     = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$table}");
    $last_id   = count($out) ? (int) $out[count($out) - 1]['id'] : $since_id;
    $remaining = (int) $wpdb->get_var($wpdb->prepare(
        "SELECT COUNT(*) FROM {$table} WHERE id > %d", $last_id
    ));

    return rest_ensure_response(array(
        'ok'          => true,
        'count'       => count($out),
        'total'       => $total,
        'since_id'    => $since_id,
        'remaining'   => $remaining,
        'now'         => gmdate('Y-m-d\TH:i:s\Z'),
        'submissions' => $out,
    ));
}
