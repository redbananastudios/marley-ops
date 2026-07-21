import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const migration = readFileSync(
  join(ROOT, "supabase/migrations/0069_crew_rls_lockdown.sql"),
  "utf8",
);

function policy(name: string, table?: string): string {
  const matches = [
    ...migration.matchAll(new RegExp(`create\\s+policy\\s+${name}\\b[\\s\\S]*?;`, "gi")),
  ].map((match) => match[0]);
  const found = table
    ? matches.find((statement) => statement.toLowerCase().includes(`on ${table.toLowerCase()} `))
    : matches[0];
  expect(found, `missing ${name}${table ? ` on ${table}` : ""}`).toBeDefined();
  return found ?? "";
}

describe("0069 crew RLS lockdown", () => {
  it("removes profile self-update while preserving office-or-self reads", () => {
    expect(migration).toMatch(/drop policy if exists profiles_self on public\.profiles/i);
    expect(migration).not.toMatch(/create\s+policy\s+profiles_self\b/i);
    expect(policy("profiles_read")).toMatch(/public\.is_office\(\)[\s\S]*id\s*=\s*auth\.uid\(\)/i);
    expect(policy("profiles_update")).toMatch(/using\s*\(public\.is_admin\(\)\)[\s\S]*with check\s*\(public\.is_admin\(\)\)/i);
  });

  it("makes direct operational reads office-only and leaves no staff-wide mutation", () => {
    const fullyReplacedTables = [
      "clients",
      "leads",
      "appointments",
      "appointment_assignments",
      "vehicles",
      "surveys",
      "survey_photos",
      "communications",
      "activities",
    ];

    for (const table of fullyReplacedTables) {
      expect(policy(`${table}_read`)).toMatch(/using\s*\(public\.is_office\(\)\)/i);
      for (const command of ["insert", "update", "delete"]) {
        expect(policy(`${table}_${command}`)).not.toMatch(/is_staff\s*\(/i);
      }
    }

    const laterReadPolicies = [
      "follow_ups_read",
      "job_completions_read",
      "job_notes_read",
      "job_media_read",
      "signatures_read",
      "storage_sites_read",
      "storage_units_read",
      "vehicle_reminder_log_read",
      "vehicle_unavailability_read",
    ];
    const laterMutationPolicies = [
      "events_insert",
      "follow_ups_insert",
      "follow_ups_update",
      "job_completions_insert",
      "job_notes_insert",
      "job_media_insert",
      "signatures_insert",
      "storage_sites_insert",
      "storage_sites_update",
      "storage_units_insert",
      "storage_units_update",
    ];

    for (const name of [...laterReadPolicies, ...laterMutationPolicies]) {
      expect(policy(name)).toMatch(/public\.is_office\(\)/i);
      expect(policy(name)).not.toMatch(/is_staff\s*\(/i);
    }
  });

  it("limits crew roster reads to self and permits only the first-login link update", () => {
    expect(policy("staff_read")).toMatch(/public\.is_office\(\)[\s\S]*public\.is_staff\(\)[\s\S]*profile_id\s*=\s*auth\.uid\(\)/i);
    expect(migration).toMatch(/function public\.enforce_staff_self_link_only\(\)[\s\S]*old\.profile_id is null[\s\S]*new\.profile_id = auth\.uid\(\)[\s\S]*public\.is_staff\(\)/i);
    expect(migration).toMatch(/to_jsonb\(new\) - 'profile_id' - 'updated_at'[\s\S]*to_jsonb\(old\) - 'profile_id' - 'updated_at'/i);
    expect(migration).toMatch(/create trigger trg_staff_self_link_guard/i);
  });

  it("uses fail-closed SECURITY DEFINER helpers without casting object text to uuid", () => {
    for (const helper of [
      "crew_can_access_appointment_object",
      "crew_can_access_lead_object",
      "crew_can_access_survey_object",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `function\\s+public\\.${helper}\\(p_object_name text\\)[\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`,
          "i",
        ),
      );
      expect(migration).toMatch(new RegExp(`revoke all on function public\\.${helper}\\(text\\) from public, anon, authenticated`, "i"));
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${helper}\\(text\\) to authenticated, service_role`, "i"));
    }

    expect(migration).not.toMatch(/split_part\([^;]*?\)\s*::\s*uuid/i);
  });

  it("binds each legacy storage bucket to its corresponding assignment helper", () => {
    expect(policy("job_photos_read", "storage.objects")).toMatch(/bucket_id\s*=\s*'job-photos'[\s\S]*crew_can_access_appointment_object\(name\)/i);
    expect(policy("job_photos_write", "storage.objects")).toMatch(/crew_can_access_appointment_object\(name\)/i);
    expect(policy("job_media_obj_read", "storage.objects")).toMatch(/bucket_id\s*=\s*'job-media'[\s\S]*crew_can_access_lead_object\(name\)/i);
    expect(policy("job_media_obj_write", "storage.objects")).toMatch(/crew_can_access_lead_object\(name\)/i);
    expect(policy("survey_photos_read", "storage.objects")).toMatch(/bucket_id\s*=\s*'survey-photos'[\s\S]*crew_can_access_survey_object\(name\)/i);
    expect(policy("survey_photos_write", "storage.objects")).toMatch(/crew_can_access_survey_object\(name\)/i);
  });
});

describe("crew jobs page after CRM read lockdown", () => {
  const page = readFileSync(join(ROOT, "app/my-jobs/page.tsx"), "utf8");

  it("keeps session auth but performs assignment-bounded CRM reads as service role", () => {
    expect(page).toContain("const profile = await getSessionProfile()");
    expect(page).toContain("const admin = createAdminClient()");
    expect(page).toMatch(/admin[\s\S]*?\.from\("appointment_assignments"\)[\s\S]*?\.eq\("staff_id", staffRow\.id\)/);
    expect(page).not.toMatch(/\bsb\s*\.from\("(?:appointment_assignments|appointments|leads|vehicles)"\)/);
  });
});

describe("service-role survey actions", () => {
  const actions = readFileSync(
    join(ROOT, "app/(dashboard)/leads/[id]/survey-actions.ts"),
    "utf8",
  );

  it("gates upload, signing, and deletion behind an active office profile", () => {
    expect(actions).toContain("const profile = await requireOfficeProfile()");
    for (const name of [
      "deleteSurveyPhoto",
      "createSurveyPhotoUploadTargetAction",
      "signSurveyPhotoUrls",
    ]) {
      expect(actions).toMatch(
        new RegExp(`function ${name}[\\s\\S]*?const context = await officeCtx\\(\\)`, "i"),
      );
    }
  });

  it("binds deletion to the path stored for the requested photo row", () => {
    expect(actions).toMatch(/select\("id, storage_path"\)[\s\S]*photo\.storage_path !== storagePath/i);
    expect(actions).toMatch(/deleteObjects\(\[photo\.storage_path\]\)/i);
    expect(actions).toMatch(/\.delete\(\)[\s\S]*\.eq\("id", photoId\)[\s\S]*\.eq\("storage_path", photo\.storage_path\)/i);
  });
});

describe("crew-owned service-role mutations", () => {
  const notes = readFileSync(join(ROOT, "app/actions/job-notes.ts"), "utf8");
  const media = readFileSync(join(ROOT, "app/actions/job-media.ts"), "utf8");

  it("requires current assignment as well as authorship for note deletion", () => {
    expect(notes).toMatch(/deleteJobNoteAction[\s\S]*crewAssignedToAppointment\(admin, prof\.id, prof\.email, note\.appointment_id\)/i);
    expect(notes).toMatch(/note\.author_id !== prof\.id \|\| !stillAssigned/i);
  });

  it("requires current assignment as well as ownership for crew media edits", () => {
    expect(media).toMatch(/updateJobMediaAction[\s\S]*crewAssignedToAppointment\(admin, prof\.id, prof\.email, row\.appointment_id\)/i);
    expect(media).toMatch(/row\.captured_by !== prof\.id \|\| !stillAssigned/i);
  });
});
