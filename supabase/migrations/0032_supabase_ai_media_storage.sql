-- 0032: Supabase Storage provisioning for the AI media-store driver.
-- This migration is intentionally provider-specific. Migration 0031 remains
-- portable standard PostgreSQL application schema.

insert into storage.buckets (id, name, public, file_size_limit)
values ('survey-media', 'survey-media', false, 524288000)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit;

drop policy if exists survey_media_read on storage.objects;
drop policy if exists survey_media_insert on storage.objects;
drop policy if exists survey_media_update on storage.objects;
drop policy if exists survey_media_delete on storage.objects;

create policy survey_media_read on storage.objects
  for select using (
    bucket_id = 'survey-media'
    and public.is_office()
  );

create policy survey_media_insert on storage.objects
  for insert with check (
    bucket_id = 'survey-media'
    and public.is_office()
    and exists (
      select 1
      from public.cubic_survey_media as media
      where media.created_by = auth.uid()
        and media.status = 'uploading'
        and media.survey_id::text = (storage.foldername(name))[1]
        and media.id::text = (storage.foldername(name))[2]
        and (
          name = media.storage_path
          or (
            array_length(storage.foldername(name), 1) = 3
            and (storage.foldername(name))[3] = 'frames'
            and lower(storage.extension(name)) in ('jpg', 'jpeg')
            and name ~ '^[0-9a-f-]+/[0-9a-f-]+/frames/[0-9]{4,8}[.](jpg|jpeg)$'
          )
        )
    )
  );

create policy survey_media_update on storage.objects
  for update using (
    bucket_id = 'survey-media'
    and public.is_office()
  ) with check (
    bucket_id = 'survey-media'
    and public.is_office()
    and exists (
      select 1 from public.cubic_survey_media as media
      where media.created_by = auth.uid()
        and media.status = 'uploading'
        and media.survey_id::text = (storage.foldername(name))[1]
        and media.id::text = (storage.foldername(name))[2]
        and (
          name = media.storage_path
          or (
            array_length(storage.foldername(name), 1) = 3
            and (storage.foldername(name))[3] = 'frames'
            and lower(storage.extension(name)) in ('jpg', 'jpeg')
            and name ~ '^[0-9a-f-]+/[0-9a-f-]+/frames/[0-9]{4,8}[.](jpg|jpeg)$'
          )
        )
    )
  );

create policy survey_media_delete on storage.objects
  for delete using (
    bucket_id = 'survey-media'
    and public.is_admin()
  );
