<?php
/**
 * Pitmans Lead Bridge — configuration SAMPLE.
 *
 * Copy this file to config.php (same directory) and fill in the real values.
 * config.php is deliberately NOT part of the repo or the shipped zip contents
 * you commit — it carries live secrets and exists only on the WordPress box.
 * Never commit it, never paste its secrets into a ticket or an email.
 *
 * The two secrets are DIFFERENT credentials on purpose (push and pull are
 * disjoint channels, so one leaked/rotated secret never takes both down):
 *
 *   ops_ingest_secret  must equal LEAD_INGEST_SECRET_PITMANS in the marley-ops
 *                      environment (the Bearer token /api/ingest/lead maps to
 *                      the pitmans brand — the brand derives from the secret,
 *                      never from the payload).
 *   pull_secret        must equal PITMANS_WP_PULL_SECRET in the marley-ops
 *                      environment (/opt/marley-ops/app.env). It signs the
 *                      read requests Ops makes to this site.
 *
 * Generate each with e.g.:  openssl rand -hex 32
 */

if (!defined('ABSPATH')) {
    exit;
}

return array(
    // Contact Form 7 form ids the bridge listens to. Find the id in the CF7
    // shortcode on the page: [contact-form-7 id="123" ...] → 123.
    'form_ids'          => array(123),

    // Where submissions are pushed. Leave as-is unless Ops moves.
    'ops_ingest_url'    => 'https://ops.marleymoves.co.uk/api/ingest/lead',

    // Fill both in. Minimum 16 characters each; the plugin treats anything
    // shorter (or containing CHANGE-ME) as unconfigured and refuses to run
    // with it.
    'ops_ingest_secret' => 'CHANGE-ME',
    'pull_secret'       => 'CHANGE-ME',

    // CF7 field name → lead field. Each entry lists the form's field names in
    // order of preference; the first non-empty one wins. Read the real names
    // off the form's edit screen (the [text* your-name] style tags) and put
    // them here — these defaults are typical CF7 names, NOT verified against
    // the live Pitmans form.
    'field_map'         => array(
        'name'           => array('your-name'),
        'phone'          => array('your-phone', 'tel'),
        'email'          => array('your-email'),
        'from_postcode'  => array('moving-from-postcode', 'from-postcode'),
        'from_address'   => array('moving-from-address', 'from-address'),
        'to_postcode'    => array('moving-to-postcode', 'to-postcode'),
        'to_address'     => array('moving-to-address', 'to-address'),
        'property_size'  => array('property-size'),
        'preferred_date' => array('moving-date', 'preferred-date'),
        // "Where did you hear about us?" — lands in leads.referrer_answer.
        'referrer'       => array('hear-about-us', 'how-did-you-hear'),
        // The Part load / Full load radio — carried as a notes line.
        'load_type'      => array('load-type', 'part-full-load'),
        'notes'          => array('your-message', 'notes'),
    ),

    // Prefix for the lead's source field ("wp_cf7_123" = form 123 on this
    // site). Change only if a second WordPress site ever runs this plugin.
    'source_prefix'     => 'wp_cf7',
);
