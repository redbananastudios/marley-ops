export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activities: {
        Row: {
          actor_id: string | null
          client_id: string | null
          created_at: string
          id: string
          lead_id: string | null
          meta: Json
          summary: string
          type: Database["public"]["Enums"]["activity_type"]
        }
        Insert: {
          actor_id?: string | null
          client_id?: string | null
          created_at?: string
          id?: string
          lead_id?: string | null
          meta?: Json
          summary: string
          type: Database["public"]["Enums"]["activity_type"]
        }
        Update: {
          actor_id?: string | null
          client_id?: string | null
          created_at?: string
          id?: string
          lead_id?: string | null
          meta?: Json
          summary?: string
          type?: Database["public"]["Enums"]["activity_type"]
        }
        Relationships: [
          {
            foreignKeyName: "activities_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_jobs: {
        Row: {
          attempts: number
          created_at: string
          error: string | null
          heartbeat_at: string | null
          id: string
          idempotency_key: string
          kind: string
          lease_expires_at: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          media_id: string | null
          next_run_at: string
          payload: Json
          status: string
          survey_id: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          error?: string | null
          heartbeat_at?: string | null
          id?: string
          idempotency_key: string
          kind: string
          lease_expires_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          media_id?: string | null
          next_run_at?: string
          payload?: Json
          status?: string
          survey_id: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          error?: string | null
          heartbeat_at?: string | null
          id?: string
          idempotency_key?: string
          kind?: string
          lease_expires_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          media_id?: string | null
          next_run_at?: string
          payload?: Json
          status?: string
          survey_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_jobs_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "cubic_surveys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_jobs_survey_id_media_id_fkey"
            columns: ["survey_id", "media_id"]
            isOneToOne: false
            referencedRelation: "cubic_survey_media"
            referencedColumns: ["survey_id", "id"]
          },
        ]
      }
      ai_spend_months: {
        Row: {
          alerted_at: string | null
          created_at: string
          month: string
          reserved_usd: number
          spent_usd: number
          updated_at: string
        }
        Insert: {
          alerted_at?: string | null
          created_at?: string
          month: string
          reserved_usd?: number
          spent_usd?: number
          updated_at?: string
        }
        Update: {
          alerted_at?: string | null
          created_at?: string
          month?: string
          reserved_usd?: number
          spent_usd?: number
          updated_at?: string
        }
        Relationships: []
      }
      ai_spend_reservations: {
        Row: {
          actual_usd: number | null
          attempt_key: string
          created_at: string
          estimated_usd: number
          finalised_at: string | null
          id: string
          job_id: string
          month: string
          status: string
          survey_id: string
          updated_at: string
        }
        Insert: {
          actual_usd?: number | null
          attempt_key: string
          created_at?: string
          estimated_usd: number
          finalised_at?: string | null
          id?: string
          job_id: string
          month: string
          status?: string
          survey_id: string
          updated_at?: string
        }
        Update: {
          actual_usd?: number | null
          attempt_key?: string
          created_at?: string
          estimated_usd?: number
          finalised_at?: string | null
          id?: string
          job_id?: string
          month?: string
          status?: string
          survey_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_spend_reservations_month_fkey"
            columns: ["month"]
            isOneToOne: false
            referencedRelation: "ai_spend_months"
            referencedColumns: ["month"]
          },
          {
            foreignKeyName: "ai_spend_reservations_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "cubic_surveys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_spend_reservations_survey_id_job_id_fkey"
            columns: ["survey_id", "job_id"]
            isOneToOne: false
            referencedRelation: "ai_jobs"
            referencedColumns: ["survey_id", "id"]
          },
        ]
      }
      appointment_assignments: {
        Row: {
          appointment_id: string
          created_at: string
          id: string
          reminded_at: string | null
          staff_id: string | null
          vehicle_id: string | null
        }
        Insert: {
          appointment_id: string
          created_at?: string
          id?: string
          reminded_at?: string | null
          staff_id?: string | null
          vehicle_id?: string | null
        }
        Update: {
          appointment_id?: string
          created_at?: string
          id?: string
          reminded_at?: string | null
          staff_id?: string | null
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "appointment_assignments_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_assignments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_assignments_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          all_day: boolean
          appt_type: Database["public"]["Enums"]["appt_type"]
          client_id: string | null
          created_at: string
          ends_at: string
          estimator_id: string | null
          gcal_event_id: string | null
          id: string
          lead_id: string | null
          location: string | null
          notes: string | null
          starts_at: string
          status: Database["public"]["Enums"]["appt_status"]
          survey_id: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          all_day?: boolean
          appt_type: Database["public"]["Enums"]["appt_type"]
          client_id?: string | null
          created_at?: string
          ends_at: string
          estimator_id?: string | null
          gcal_event_id?: string | null
          id?: string
          lead_id?: string | null
          location?: string | null
          notes?: string | null
          starts_at: string
          status?: Database["public"]["Enums"]["appt_status"]
          survey_id?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          all_day?: boolean
          appt_type?: Database["public"]["Enums"]["appt_type"]
          client_id?: string | null
          created_at?: string
          ends_at?: string
          estimator_id?: string | null
          gcal_event_id?: string | null
          id?: string
          lead_id?: string | null
          location?: string | null
          notes?: string | null
          starts_at?: string
          status?: Database["public"]["Enums"]["appt_status"]
          survey_id?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_estimator_id_fkey"
            columns: ["estimator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "surveys"
            referencedColumns: ["id"]
          },
        ]
      }
      business_settings: {
        Row: {
          ai_grounded_replay_enabled: boolean
          ai_model_default: string
          ai_model_escalation: string
          ai_monthly_alert_gbp: number
          ai_monthly_cap_gbp: number
          ai_survey_cap_gbp: number
          ai_survey_enabled: boolean
          base_location: string
          cost_75t: number
          cost_box: number
          cost_fuel_75_per_mile: number
          cost_fuel_per_mile: number
          cost_labour_per_day: number
          cost_misc: number
          cost_transit_day: number
          cost_van_day: number
          cubic_75t_ft3: number
          cubic_fill_pct: number
          cubic_luton_ft3: number
          cubic_transit_ft3: number
          default_deposit: number
          estimator_fee: number
          google_review_url: string
          id: boolean
          pricing: Json | null
          updated_at: string
          vat_default: boolean
          vat_number: string | null
        }
        Insert: {
          ai_grounded_replay_enabled?: boolean
          ai_model_default?: string
          ai_model_escalation?: string
          ai_monthly_alert_gbp?: number
          ai_monthly_cap_gbp?: number
          ai_survey_cap_gbp?: number
          ai_survey_enabled?: boolean
          base_location?: string
          cost_75t?: number
          cost_box?: number
          cost_fuel_75_per_mile?: number
          cost_fuel_per_mile?: number
          cost_labour_per_day?: number
          cost_misc?: number
          cost_transit_day?: number
          cost_van_day?: number
          cubic_75t_ft3?: number
          cubic_fill_pct?: number
          cubic_luton_ft3?: number
          cubic_transit_ft3?: number
          default_deposit?: number
          estimator_fee?: number
          google_review_url?: string
          id?: boolean
          pricing?: Json | null
          updated_at?: string
          vat_default?: boolean
          vat_number?: string | null
        }
        Update: {
          ai_grounded_replay_enabled?: boolean
          ai_model_default?: string
          ai_model_escalation?: string
          ai_monthly_alert_gbp?: number
          ai_monthly_cap_gbp?: number
          ai_survey_cap_gbp?: number
          ai_survey_enabled?: boolean
          base_location?: string
          cost_75t?: number
          cost_box?: number
          cost_fuel_75_per_mile?: number
          cost_fuel_per_mile?: number
          cost_labour_per_day?: number
          cost_misc?: number
          cost_transit_day?: number
          cost_van_day?: number
          cubic_75t_ft3?: number
          cubic_fill_pct?: number
          cubic_luton_ft3?: number
          cubic_transit_ft3?: number
          default_deposit?: number
          estimator_fee?: number
          google_review_url?: string
          id?: boolean
          pricing?: Json | null
          updated_at?: string
          vat_default?: boolean
          vat_number?: string | null
        }
        Relationships: []
      }
      clients: {
        Row: {
          address_line1: string | null
          alt_phone: string | null
          business_number: string | null
          company_name: string | null
          country: string
          county: string | null
          created_at: string
          display_name: string | null
          email: string | null
          email_norm: string | null
          first_name: string | null
          id: string
          is_active: boolean
          is_company: boolean
          last_name: string | null
          merged_into_id: string | null
          notes: string | null
          phone_e164: string | null
          phone_raw: string | null
          postcode_home: string | null
          secondary_emails: string[]
          town: string | null
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          alt_phone?: string | null
          business_number?: string | null
          company_name?: string | null
          country?: string
          county?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          email_norm?: string | null
          first_name?: string | null
          id?: string
          is_active?: boolean
          is_company?: boolean
          last_name?: string | null
          merged_into_id?: string | null
          notes?: string | null
          phone_e164?: string | null
          phone_raw?: string | null
          postcode_home?: string | null
          secondary_emails?: string[]
          town?: string | null
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          alt_phone?: string | null
          business_number?: string | null
          company_name?: string | null
          country?: string
          county?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          email_norm?: string | null
          first_name?: string | null
          id?: string
          is_active?: boolean
          is_company?: boolean
          last_name?: string | null
          merged_into_id?: string | null
          notes?: string | null
          phone_e164?: string | null
          phone_raw?: string | null
          postcode_home?: string | null
          secondary_emails?: string[]
          town?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clients_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      communications: {
        Row: {
          attachment_ref: string | null
          body: string
          channel: Database["public"]["Enums"]["comm_channel"]
          client_id: string | null
          content_hash: string
          created_at: string
          direction: string
          first_sent_at: string | null
          id: string
          is_override: boolean
          last_sent_at: string | null
          lead_id: string | null
          override_reason: string | null
          provider: string | null
          provider_error: string | null
          provider_id: string | null
          quote_id: string | null
          send_count: number
          sent_by: string | null
          status: Database["public"]["Enums"]["comm_status"]
          subject: string | null
          to_address: string
          to_norm: string
          updated_at: string
        }
        Insert: {
          attachment_ref?: string | null
          body: string
          channel: Database["public"]["Enums"]["comm_channel"]
          client_id?: string | null
          content_hash: string
          created_at?: string
          direction?: string
          first_sent_at?: string | null
          id?: string
          is_override?: boolean
          last_sent_at?: string | null
          lead_id?: string | null
          override_reason?: string | null
          provider?: string | null
          provider_error?: string | null
          provider_id?: string | null
          quote_id?: string | null
          send_count?: number
          sent_by?: string | null
          status?: Database["public"]["Enums"]["comm_status"]
          subject?: string | null
          to_address: string
          to_norm: string
          updated_at?: string
        }
        Update: {
          attachment_ref?: string | null
          body?: string
          channel?: Database["public"]["Enums"]["comm_channel"]
          client_id?: string | null
          content_hash?: string
          created_at?: string
          direction?: string
          first_sent_at?: string | null
          id?: string
          is_override?: boolean
          last_sent_at?: string | null
          lead_id?: string | null
          override_reason?: string | null
          provider?: string | null
          provider_error?: string | null
          provider_id?: string | null
          quote_id?: string | null
          send_count?: number
          sent_by?: string | null
          status?: Database["public"]["Enums"]["comm_status"]
          subject?: string | null
          to_address?: string
          to_norm?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "communications_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cubic_ai_detections: {
        Row: {
          candidates: Json
          catalogue_key: string | null
          confidence: number
          created_at: string
          evidence: Json
          flags: Json
          id: string
          label: string
          moving: string
          qty: number
          resolution: Json | null
          review_reason: string | null
          room_id: string | null
          run_id: string
          segment_id: string | null
          state: string
          survey_id: string
          updated_at: string
        }
        Insert: {
          candidates?: Json
          catalogue_key?: string | null
          confidence?: number
          created_at?: string
          evidence?: Json
          flags?: Json
          id?: string
          label: string
          moving?: string
          qty?: number
          resolution?: Json | null
          review_reason?: string | null
          room_id?: string | null
          run_id: string
          segment_id?: string | null
          state?: string
          survey_id: string
          updated_at?: string
        }
        Update: {
          candidates?: Json
          catalogue_key?: string | null
          confidence?: number
          created_at?: string
          evidence?: Json
          flags?: Json
          id?: string
          label?: string
          moving?: string
          qty?: number
          resolution?: Json | null
          review_reason?: string | null
          room_id?: string | null
          run_id?: string
          segment_id?: string | null
          state?: string
          survey_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cubic_ai_detections_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "cubic_surveys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cubic_ai_detections_survey_id_room_id_fkey"
            columns: ["survey_id", "room_id"]
            isOneToOne: false
            referencedRelation: "cubic_survey_rooms"
            referencedColumns: ["survey_id", "id"]
          },
          {
            foreignKeyName: "cubic_ai_detections_survey_id_run_id_fkey"
            columns: ["survey_id", "run_id"]
            isOneToOne: false
            referencedRelation: "cubic_analysis_runs"
            referencedColumns: ["survey_id", "id"]
          },
          {
            foreignKeyName: "cubic_ai_detections_survey_id_segment_id_fkey"
            columns: ["survey_id", "segment_id"]
            isOneToOne: false
            referencedRelation: "cubic_survey_segments"
            referencedColumns: ["survey_id", "id"]
          },
        ]
      }
      cubic_analysis_runs: {
        Row: {
          attempt_key: string
          cost_usd: number | null
          error: string | null
          finished_at: string | null
          id: string
          input_tokens: number | null
          media_id: string | null
          model: string
          output_tokens: number | null
          prompt_version: string
          provider_deleted_at: string | null
          provider_file_name: string | null
          purpose: string
          reserved_cost_usd: number
          started_at: string
          status: string
          survey_id: string
        }
        Insert: {
          attempt_key: string
          cost_usd?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          input_tokens?: number | null
          media_id?: string | null
          model: string
          output_tokens?: number | null
          prompt_version: string
          provider_deleted_at?: string | null
          provider_file_name?: string | null
          purpose: string
          reserved_cost_usd?: number
          started_at?: string
          status?: string
          survey_id: string
        }
        Update: {
          attempt_key?: string
          cost_usd?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          input_tokens?: number | null
          media_id?: string | null
          model?: string
          output_tokens?: number | null
          prompt_version?: string
          provider_deleted_at?: string | null
          provider_file_name?: string | null
          purpose?: string
          reserved_cost_usd?: number
          started_at?: string
          status?: string
          survey_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cubic_analysis_runs_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "cubic_surveys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cubic_analysis_runs_survey_id_media_id_fkey"
            columns: ["survey_id", "media_id"]
            isOneToOne: false
            referencedRelation: "cubic_survey_media"
            referencedColumns: ["survey_id", "id"]
          },
        ]
      }
      cubic_survey_media: {
        Row: {
          bytes: number | null
          coverage: string | null
          created_at: string
          created_by: string | null
          duration_s: number | null
          error: string | null
          finalized_at: string | null
          frames: Json
          id: string
          kind: string
          mime: string
          quality_flags: Json
          room_id: string | null
          status: string
          storage_path: string
          survey_id: string
          updated_at: string
        }
        Insert: {
          bytes?: number | null
          coverage?: string | null
          created_at?: string
          created_by?: string | null
          duration_s?: number | null
          error?: string | null
          finalized_at?: string | null
          frames?: Json
          id?: string
          kind: string
          mime: string
          quality_flags?: Json
          room_id?: string | null
          status?: string
          storage_path: string
          survey_id: string
          updated_at?: string
        }
        Update: {
          bytes?: number | null
          coverage?: string | null
          created_at?: string
          created_by?: string | null
          duration_s?: number | null
          error?: string | null
          finalized_at?: string | null
          frames?: Json
          id?: string
          kind?: string
          mime?: string
          quality_flags?: Json
          room_id?: string | null
          status?: string
          storage_path?: string
          survey_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cubic_survey_media_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cubic_survey_media_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "cubic_surveys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cubic_survey_media_survey_id_room_id_fkey"
            columns: ["survey_id", "room_id"]
            isOneToOne: false
            referencedRelation: "cubic_survey_rooms"
            referencedColumns: ["survey_id", "id"]
          },
        ]
      }
      cubic_survey_rooms: {
        Row: {
          completion_method: string | null
          coverage: string | null
          created_at: string
          created_by: string | null
          floor: string | null
          hidden_storage_checked: boolean
          id: string
          name: string
          quality_flags: Json
          quality_warnings: Json
          room_type: string | null
          sort: number
          status: string
          survey_id: string
          updated_at: string
        }
        Insert: {
          completion_method?: string | null
          coverage?: string | null
          created_at?: string
          created_by?: string | null
          floor?: string | null
          hidden_storage_checked?: boolean
          id?: string
          name: string
          quality_flags?: Json
          quality_warnings?: Json
          room_type?: string | null
          sort?: number
          status?: string
          survey_id: string
          updated_at?: string
        }
        Update: {
          completion_method?: string | null
          coverage?: string | null
          created_at?: string
          created_by?: string | null
          floor?: string | null
          hidden_storage_checked?: boolean
          id?: string
          name?: string
          quality_flags?: Json
          quality_warnings?: Json
          room_type?: string | null
          sort?: number
          status?: string
          survey_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cubic_survey_rooms_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cubic_survey_rooms_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "cubic_surveys"
            referencedColumns: ["id"]
          },
        ]
      }
      cubic_survey_segments: {
        Row: {
          created_at: string
          end_s: number
          id: string
          media_id: string
          model_ref: string
          proposed_name: string
          room_id: string | null
          start_s: number
          status: string
          survey_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          end_s: number
          id?: string
          media_id: string
          model_ref: string
          proposed_name: string
          room_id?: string | null
          start_s: number
          status?: string
          survey_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          end_s?: number
          id?: string
          media_id?: string
          model_ref?: string
          proposed_name?: string
          room_id?: string | null
          start_s?: number
          status?: string
          survey_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cubic_survey_segments_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "cubic_surveys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cubic_survey_segments_survey_id_media_id_fkey"
            columns: ["survey_id", "media_id"]
            isOneToOne: false
            referencedRelation: "cubic_survey_media"
            referencedColumns: ["survey_id", "id"]
          },
          {
            foreignKeyName: "cubic_survey_segments_survey_id_room_id_fkey"
            columns: ["survey_id", "room_id"]
            isOneToOne: false
            referencedRelation: "cubic_survey_rooms"
            referencedColumns: ["survey_id", "id"]
          },
        ]
      }
      cubic_surveys: {
        Row: {
          ai_abandoned_at: string | null
          ai_consent: Json | null
          ai_consent_withdrawn_at: string | null
          ai_consent_withdrawn_by: string | null
          ai_status: string
          appointment_id: string | null
          client_id: string | null
          contingency_pct: number
          created_at: string
          created_by: string | null
          customer_notes: string
          id: string
          items: Json
          last_ai_user_activity_at: string | null
          lead_id: string | null
          legal_hold: boolean
          media_retention_anchor_at: string | null
          notes: string
          planning_ready: boolean
          room_manifest_complete: boolean
          share_token: string | null
          status: string
          total_ft3: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          ai_abandoned_at?: string | null
          ai_consent?: Json | null
          ai_consent_withdrawn_at?: string | null
          ai_consent_withdrawn_by?: string | null
          ai_status?: string
          appointment_id?: string | null
          client_id?: string | null
          contingency_pct?: number
          created_at?: string
          created_by?: string | null
          customer_notes?: string
          id?: string
          items?: Json
          last_ai_user_activity_at?: string | null
          lead_id?: string | null
          legal_hold?: boolean
          media_retention_anchor_at?: string | null
          notes?: string
          planning_ready?: boolean
          room_manifest_complete?: boolean
          share_token?: string | null
          status?: string
          total_ft3?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          ai_abandoned_at?: string | null
          ai_consent?: Json | null
          ai_consent_withdrawn_at?: string | null
          ai_consent_withdrawn_by?: string | null
          ai_status?: string
          appointment_id?: string | null
          client_id?: string | null
          contingency_pct?: number
          created_at?: string
          created_by?: string | null
          customer_notes?: string
          id?: string
          items?: Json
          last_ai_user_activity_at?: string | null
          lead_id?: string | null
          legal_hold?: boolean
          media_retention_anchor_at?: string | null
          notes?: string
          planning_ready?: boolean
          room_manifest_complete?: boolean
          share_token?: string | null
          status?: string
          total_ft3?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cubic_surveys_ai_consent_withdrawn_by_fkey"
            columns: ["ai_consent_withdrawn_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cubic_surveys_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cubic_surveys_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cubic_surveys_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cubic_surveys_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cubic_surveys_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      estimator_payouts: {
        Row: {
          amount: number
          created_at: string
          estimator_id: string
          id: string
          paid_at: string | null
          period_month: string
          updated_at: string
          visits: number
        }
        Insert: {
          amount?: number
          created_at?: string
          estimator_id: string
          id?: string
          paid_at?: string | null
          period_month: string
          updated_at?: string
          visits?: number
        }
        Update: {
          amount?: number
          created_at?: string
          estimator_id?: string
          id?: string
          paid_at?: string | null
          period_month?: string
          updated_at?: string
          visits?: number
        }
        Relationships: [
          {
            foreignKeyName: "estimator_payouts_estimator_id_fkey"
            columns: ["estimator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      events_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          diff: Json | null
          entity_id: string | null
          entity_type: string
          id: number
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          diff?: Json | null
          entity_id?: string | null
          entity_type: string
          id?: never
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          diff?: Json | null
          entity_id?: string | null
          entity_type?: string
          id?: never
        }
        Relationships: [
          {
            foreignKeyName: "events_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      follow_ups: {
        Row: {
          assigned_to: string | null
          attempt_count: number
          client_id: string | null
          created_at: string
          created_by: string | null
          due_at: string
          id: string
          last_attempt_at: string | null
          lead_id: string
          metadata: Json
          notes: string | null
          outcome: Database["public"]["Enums"]["follow_up_outcome"] | null
          quote_id: string | null
          reason: Database["public"]["Enums"]["follow_up_reason"]
          source: string
          status: Database["public"]["Enums"]["follow_up_status"]
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          attempt_count?: number
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          due_at: string
          id?: string
          last_attempt_at?: string | null
          lead_id: string
          metadata?: Json
          notes?: string | null
          outcome?: Database["public"]["Enums"]["follow_up_outcome"] | null
          quote_id?: string | null
          reason: Database["public"]["Enums"]["follow_up_reason"]
          source?: string
          status?: Database["public"]["Enums"]["follow_up_status"]
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          attempt_count?: number
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          due_at?: string
          id?: string
          last_attempt_at?: string | null
          lead_id?: string
          metadata?: Json
          notes?: string | null
          outcome?: Database["public"]["Enums"]["follow_up_outcome"] | null
          quote_id?: string | null
          reason?: Database["public"]["Enums"]["follow_up_reason"]
          source?: string
          status?: Database["public"]["Enums"]["follow_up_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_ups_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      job_completions: {
        Row: {
          absent_reason: string | null
          appointment_id: string
          certificate_emailed_at: string | null
          certificate_path: string | null
          client_id: string | null
          completed_by: string | null
          created_at: string
          crew_name: string
          crew_signature: string
          crew_staff_id: string | null
          customer_absent: boolean
          customer_name: string | null
          customer_signature: string | null
          exceptions: string
          id: string
          lead_id: string | null
          signed_at: string
        }
        Insert: {
          absent_reason?: string | null
          appointment_id: string
          certificate_emailed_at?: string | null
          certificate_path?: string | null
          client_id?: string | null
          completed_by?: string | null
          created_at?: string
          crew_name: string
          crew_signature: string
          crew_staff_id?: string | null
          customer_absent?: boolean
          customer_name?: string | null
          customer_signature?: string | null
          exceptions?: string
          id?: string
          lead_id?: string | null
          signed_at?: string
        }
        Update: {
          absent_reason?: string | null
          appointment_id?: string
          certificate_emailed_at?: string | null
          certificate_path?: string | null
          client_id?: string | null
          completed_by?: string | null
          created_at?: string
          crew_name?: string
          crew_signature?: string
          crew_staff_id?: string | null
          customer_absent?: boolean
          customer_name?: string | null
          customer_signature?: string | null
          exceptions?: string
          id?: string
          lead_id?: string | null
          signed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_completions_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: true
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_completions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_completions_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_completions_crew_staff_id_fkey"
            columns: ["crew_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_completions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      job_notes: {
        Row: {
          appointment_id: string | null
          author_id: string | null
          author_name: string
          body: string
          client_id: string | null
          created_at: string
          id: string
          lead_id: string | null
          photo_paths: string[]
        }
        Insert: {
          appointment_id?: string | null
          author_id?: string | null
          author_name: string
          body?: string
          client_id?: string | null
          created_at?: string
          id?: string
          lead_id?: string | null
          photo_paths?: string[]
        }
        Update: {
          appointment_id?: string | null
          author_id?: string | null
          author_name?: string
          body?: string
          client_id?: string | null
          created_at?: string
          id?: string
          lead_id?: string | null
          photo_paths?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "job_notes_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          balance_amount: number | null
          balance_due_date: string | null
          balance_paid_at: string | null
          campaign: string | null
          chase_paused: boolean
          client_id: string
          created_at: string
          deposit_amount: number | null
          deposit_chase_at: string | null
          deposit_chase_step: number
          deposit_paid_at: string | null
          deposit_requested_at: string | null
          email: string | null
          entry_channel: Database["public"]["Enums"]["lead_entry_channel"]
          estimate_given: number | null
          estimator_id: string | null
          external_lead_id: string | null
          fbclid: string | null
          first_contacted_at: string | null
          from_address: string | null
          from_postcode: string | null
          gbraid: string | null
          gclid: string | null
          id: string
          landing_referrer: string | null
          landing_url: string | null
          li_fat_id: string | null
          lost_at: string | null
          lost_note: string | null
          lost_reason: string | null
          msclkid: string | null
          name: string | null
          notes: string | null
          phone: string | null
          posthog_distinct_id: string | null
          preferred_date: string | null
          property_size: string | null
          quote_chase_at: string | null
          quote_chase_step: number
          referrer_answer: string | null
          review_requested_at: string | null
          sanity_id: string | null
          services: string[]
          source_form: string | null
          source_system: string
          status: Database["public"]["Enums"]["lead_status"]
          submitted_at: string
          to_address: string | null
          to_postcode: string | null
          ttclid: string | null
          updated_at: string
          utm_campaign: string | null
          utm_content: string | null
          utm_id: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
          variant_key: string | null
          wbraid: string | null
        }
        Insert: {
          balance_amount?: number | null
          balance_due_date?: string | null
          balance_paid_at?: string | null
          campaign?: string | null
          chase_paused?: boolean
          client_id: string
          created_at?: string
          deposit_amount?: number | null
          deposit_chase_at?: string | null
          deposit_chase_step?: number
          deposit_paid_at?: string | null
          deposit_requested_at?: string | null
          email?: string | null
          entry_channel?: Database["public"]["Enums"]["lead_entry_channel"]
          estimate_given?: number | null
          estimator_id?: string | null
          external_lead_id?: string | null
          fbclid?: string | null
          first_contacted_at?: string | null
          from_address?: string | null
          from_postcode?: string | null
          gbraid?: string | null
          gclid?: string | null
          id?: string
          landing_referrer?: string | null
          landing_url?: string | null
          li_fat_id?: string | null
          lost_at?: string | null
          lost_note?: string | null
          lost_reason?: string | null
          msclkid?: string | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          posthog_distinct_id?: string | null
          preferred_date?: string | null
          property_size?: string | null
          quote_chase_at?: string | null
          quote_chase_step?: number
          referrer_answer?: string | null
          review_requested_at?: string | null
          sanity_id?: string | null
          services?: string[]
          source_form?: string | null
          source_system?: string
          status?: Database["public"]["Enums"]["lead_status"]
          submitted_at?: string
          to_address?: string | null
          to_postcode?: string | null
          ttclid?: string | null
          updated_at?: string
          utm_campaign?: string | null
          utm_content?: string | null
          utm_id?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          variant_key?: string | null
          wbraid?: string | null
        }
        Update: {
          balance_amount?: number | null
          balance_due_date?: string | null
          balance_paid_at?: string | null
          campaign?: string | null
          chase_paused?: boolean
          client_id?: string
          created_at?: string
          deposit_amount?: number | null
          deposit_chase_at?: string | null
          deposit_chase_step?: number
          deposit_paid_at?: string | null
          deposit_requested_at?: string | null
          email?: string | null
          entry_channel?: Database["public"]["Enums"]["lead_entry_channel"]
          estimate_given?: number | null
          estimator_id?: string | null
          external_lead_id?: string | null
          fbclid?: string | null
          first_contacted_at?: string | null
          from_address?: string | null
          from_postcode?: string | null
          gbraid?: string | null
          gclid?: string | null
          id?: string
          landing_referrer?: string | null
          landing_url?: string | null
          li_fat_id?: string | null
          lost_at?: string | null
          lost_note?: string | null
          lost_reason?: string | null
          msclkid?: string | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          posthog_distinct_id?: string | null
          preferred_date?: string | null
          property_size?: string | null
          quote_chase_at?: string | null
          quote_chase_step?: number
          referrer_answer?: string | null
          review_requested_at?: string | null
          sanity_id?: string | null
          services?: string[]
          source_form?: string | null
          source_system?: string
          status?: Database["public"]["Enums"]["lead_status"]
          submitted_at?: string
          to_address?: string | null
          to_postcode?: string | null
          ttclid?: string | null
          updated_at?: string
          utm_campaign?: string | null
          utm_content?: string | null
          utm_id?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          variant_key?: string | null
          wbraid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_estimator_id_fkey"
            columns: ["estimator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          created_at: string
          email: string | null
          full_name: string
          id: string
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          email?: string | null
          full_name?: string
          id: string
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: []
      }
      quotes: {
        Row: {
          accept_token: string | null
          accepted_at: string | null
          accepted_ip: string | null
          accepted_name: string | null
          agreed_price: number | null
          balance_invoice_amount: number | null
          balance_invoice_created_at: string | null
          breakdown: Json
          client_id: string | null
          collect_addr: string | null
          created_at: string
          customer_email: string | null
          customer_name: string | null
          customer_phone: string | null
          declined_at: string | null
          declined_reason: string | null
          deposit_amount: number | null
          deposit_paid_at: string | null
          deposit_paid_method: string | null
          deposit_selfreport_at: string | null
          dest_addr: string | null
          discount: number
          email_error: string | null
          email_message_id: string | null
          email_send_count: number
          email_sent: boolean
          email_sent_at: string | null
          estimator_id: string | null
          grand_total: number
          id: string
          lead_id: string | null
          moving_date: string | null
          moving_date_estimated: boolean
          packing: string | null
          pdf_path: string | null
          quote_ref: string
          sms_send_count: number
          state_blob: Json
          status: Database["public"]["Enums"]["quote_status"]
          subtotal: number
          total_miles: number | null
          updated_at: string
          vat_amount: number
          vat_enabled: boolean
          vehicle: string | null
          zoho_balance_invoice_id: string | null
          zoho_balance_invoice_number: string | null
          zoho_balance_invoice_url: string | null
          zoho_contact_id: string | null
          zoho_deposit_error: string | null
          zoho_deposit_invoice_id: string | null
          zoho_deposit_invoice_number: string | null
          zoho_deposit_invoice_url: string | null
        }
        Insert: {
          accept_token?: string | null
          accepted_at?: string | null
          accepted_ip?: string | null
          accepted_name?: string | null
          agreed_price?: number | null
          balance_invoice_amount?: number | null
          balance_invoice_created_at?: string | null
          breakdown?: Json
          client_id?: string | null
          collect_addr?: string | null
          created_at?: string
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          declined_at?: string | null
          declined_reason?: string | null
          deposit_amount?: number | null
          deposit_paid_at?: string | null
          deposit_paid_method?: string | null
          deposit_selfreport_at?: string | null
          dest_addr?: string | null
          discount?: number
          email_error?: string | null
          email_message_id?: string | null
          email_send_count?: number
          email_sent?: boolean
          email_sent_at?: string | null
          estimator_id?: string | null
          grand_total?: number
          id?: string
          lead_id?: string | null
          moving_date?: string | null
          moving_date_estimated?: boolean
          packing?: string | null
          pdf_path?: string | null
          quote_ref: string
          sms_send_count?: number
          state_blob?: Json
          status?: Database["public"]["Enums"]["quote_status"]
          subtotal?: number
          total_miles?: number | null
          updated_at?: string
          vat_amount?: number
          vat_enabled?: boolean
          vehicle?: string | null
          zoho_balance_invoice_id?: string | null
          zoho_balance_invoice_number?: string | null
          zoho_balance_invoice_url?: string | null
          zoho_contact_id?: string | null
          zoho_deposit_error?: string | null
          zoho_deposit_invoice_id?: string | null
          zoho_deposit_invoice_number?: string | null
          zoho_deposit_invoice_url?: string | null
        }
        Update: {
          accept_token?: string | null
          accepted_at?: string | null
          accepted_ip?: string | null
          accepted_name?: string | null
          agreed_price?: number | null
          balance_invoice_amount?: number | null
          balance_invoice_created_at?: string | null
          breakdown?: Json
          client_id?: string | null
          collect_addr?: string | null
          created_at?: string
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          declined_at?: string | null
          declined_reason?: string | null
          deposit_amount?: number | null
          deposit_paid_at?: string | null
          deposit_paid_method?: string | null
          deposit_selfreport_at?: string | null
          dest_addr?: string | null
          discount?: number
          email_error?: string | null
          email_message_id?: string | null
          email_send_count?: number
          email_sent?: boolean
          email_sent_at?: string | null
          estimator_id?: string | null
          grand_total?: number
          id?: string
          lead_id?: string | null
          moving_date?: string | null
          moving_date_estimated?: boolean
          packing?: string | null
          pdf_path?: string | null
          quote_ref?: string
          sms_send_count?: number
          state_blob?: Json
          status?: Database["public"]["Enums"]["quote_status"]
          subtotal?: number
          total_miles?: number | null
          updated_at?: string
          vat_amount?: number
          vat_enabled?: boolean
          vehicle?: string | null
          zoho_balance_invoice_id?: string | null
          zoho_balance_invoice_number?: string | null
          zoho_balance_invoice_url?: string | null
          zoho_contact_id?: string | null
          zoho_deposit_error?: string | null
          zoho_deposit_invoice_id?: string | null
          zoho_deposit_invoice_number?: string | null
          zoho_deposit_invoice_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_estimator_id_fkey"
            columns: ["estimator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      signatures: {
        Row: {
          acknowledgments: Json
          channel: string
          client_id: string | null
          collected_by: string | null
          created_at: string
          id: string
          ip: string | null
          kind: string
          lead_id: string | null
          method: string
          quote_id: string | null
          signature_data: string | null
          signed_at: string
          signer_name: string
          storage_let_id: string | null
          terms_version: string | null
          user_agent: string | null
        }
        Insert: {
          acknowledgments?: Json
          channel: string
          client_id?: string | null
          collected_by?: string | null
          created_at?: string
          id?: string
          ip?: string | null
          kind: string
          lead_id?: string | null
          method: string
          quote_id?: string | null
          signature_data?: string | null
          signed_at?: string
          signer_name: string
          storage_let_id?: string | null
          terms_version?: string | null
          user_agent?: string | null
        }
        Update: {
          acknowledgments?: Json
          channel?: string
          client_id?: string | null
          collected_by?: string | null
          created_at?: string
          id?: string
          ip?: string | null
          kind?: string
          lead_id?: string | null
          method?: string
          quote_id?: string | null
          signature_data?: string | null
          signed_at?: string
          signer_name?: string
          storage_let_id?: string | null
          terms_version?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signatures_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signatures_collected_by_fkey"
            columns: ["collected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signatures_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signatures_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signatures_storage_let_id_fkey"
            columns: ["storage_let_id"]
            isOneToOne: false
            referencedRelation: "storage_lets"
            referencedColumns: ["id"]
          },
        ]
      }
      staff: {
        Row: {
          created_at: string
          day_rate: number | null
          email: string | null
          full_name: string
          id: string
          is_active: boolean
          notes: string | null
          phone: string | null
          profile_id: string | null
          staff_role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          day_rate?: number | null
          email?: string | null
          full_name: string
          id?: string
          is_active?: boolean
          notes?: string | null
          phone?: string | null
          profile_id?: string | null
          staff_role?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          day_rate?: number | null
          email?: string | null
          full_name?: string
          id?: string
          is_active?: boolean
          notes?: string | null
          phone?: string | null
          profile_id?: string | null
          staff_role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      storage_invoices: {
        Row: {
          amount: number
          client_id: string | null
          created_at: string
          emailed_at: string | null
          error: string | null
          id: string
          let_id: string
          period_end: string
          period_start: string
          status: string
          updated_at: string
          zoho_invoice_id: string | null
          zoho_invoice_number: string | null
          zoho_invoice_url: string | null
        }
        Insert: {
          amount: number
          client_id?: string | null
          created_at?: string
          emailed_at?: string | null
          error?: string | null
          id?: string
          let_id: string
          period_end: string
          period_start: string
          status?: string
          updated_at?: string
          zoho_invoice_id?: string | null
          zoho_invoice_number?: string | null
          zoho_invoice_url?: string | null
        }
        Update: {
          amount?: number
          client_id?: string | null
          created_at?: string
          emailed_at?: string | null
          error?: string | null
          id?: string
          let_id?: string
          period_end?: string
          period_start?: string
          status?: string
          updated_at?: string
          zoho_invoice_id?: string | null
          zoho_invoice_number?: string | null
          zoho_invoice_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "storage_invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storage_invoices_let_id_fkey"
            columns: ["let_id"]
            isOneToOne: false
            referencedRelation: "storage_lets"
            referencedColumns: ["id"]
          },
        ]
      }
      storage_lets: {
        Row: {
          billing_paused: boolean
          client_id: string
          created_at: string
          end_date: string | null
          id: string
          lead_id: string | null
          notes: string | null
          rate: number | null
          rate_period: string
          sign_token: string | null
          start_date: string
          unit_id: string
          updated_at: string
        }
        Insert: {
          billing_paused?: boolean
          client_id: string
          created_at?: string
          end_date?: string | null
          id?: string
          lead_id?: string | null
          notes?: string | null
          rate?: number | null
          rate_period?: string
          sign_token?: string | null
          start_date: string
          unit_id: string
          updated_at?: string
        }
        Update: {
          billing_paused?: boolean
          client_id?: string
          created_at?: string
          end_date?: string | null
          id?: string
          lead_id?: string | null
          notes?: string | null
          rate?: number | null
          rate_period?: string
          sign_token?: string | null
          start_date?: string
          unit_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "storage_lets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storage_lets_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storage_lets_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "storage_units"
            referencedColumns: ["id"]
          },
        ]
      }
      storage_sites: {
        Row: {
          address: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          address?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          address?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      storage_units: {
        Row: {
          code: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          notes: string | null
          site_id: string
          size_cuft: number | null
          unit_type: string
          updated_at: string
        }
        Insert: {
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          site_id: string
          size_cuft?: number | null
          unit_type?: string
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          site_id?: string
          size_cuft?: number | null
          unit_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "storage_units_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "storage_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      survey_photos: {
        Row: {
          caption: string | null
          category: Database["public"]["Enums"]["photo_category"]
          created_at: string
          id: string
          storage_path: string
          survey_id: string
          uploaded_by: string | null
        }
        Insert: {
          caption?: string | null
          category: Database["public"]["Enums"]["photo_category"]
          created_at?: string
          id?: string
          storage_path: string
          survey_id: string
          uploaded_by?: string | null
        }
        Update: {
          caption?: string | null
          category?: Database["public"]["Enums"]["photo_category"]
          created_at?: string
          id?: string
          storage_path?: string
          survey_id?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "survey_photos_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "surveys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "survey_photos_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      surveys: {
        Row: {
          client_id: string | null
          created_at: string
          estimator_id: string | null
          id: string
          lead_id: string | null
          status: Database["public"]["Enums"]["survey_status"]
          survey_data: Json
          updated_at: string
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          estimator_id?: string | null
          id?: string
          lead_id?: string | null
          status?: Database["public"]["Enums"]["survey_status"]
          survey_data?: Json
          updated_at?: string
        }
        Update: {
          client_id?: string | null
          created_at?: string
          estimator_id?: string | null
          id?: string
          lead_id?: string | null
          status?: Database["public"]["Enums"]["survey_status"]
          survey_data?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "surveys_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "surveys_estimator_id_fkey"
            columns: ["estimator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "surveys_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicles: {
        Row: {
          cost_per_month: number | null
          created_at: string
          end_of_term: string | null
          id: string
          insurance_renewal: string | null
          is_active: boolean
          last_service: string | null
          mot_due: string | null
          name: string
          notes: string | null
          payment_day: number | null
          registration: string
          tax_due: string | null
          updated_at: string
          vehicle_type: string
        }
        Insert: {
          cost_per_month?: number | null
          created_at?: string
          end_of_term?: string | null
          id?: string
          insurance_renewal?: string | null
          is_active?: boolean
          last_service?: string | null
          mot_due?: string | null
          name: string
          notes?: string | null
          payment_day?: number | null
          registration?: string
          tax_due?: string | null
          updated_at?: string
          vehicle_type?: string
        }
        Update: {
          cost_per_month?: number | null
          created_at?: string
          end_of_term?: string | null
          id?: string
          insurance_renewal?: string | null
          is_active?: boolean
          last_service?: string | null
          mot_due?: string | null
          name?: string
          notes?: string | null
          payment_day?: number | null
          registration?: string
          tax_due?: string | null
          updated_at?: string
          vehicle_type?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      assign_ai_segment: {
        Args: {
          p_action: string
          p_actor_id: string
          p_new_room: string | null
          p_room_id: string | null
          p_segment_id: string
        }
        Returns: Json
      }
      claim_ai_jobs: {
        Args: { p_batch?: number; p_lease_seconds?: number; p_worker: string }
        Returns: {
          attempts: number
          created_at: string
          error: string | null
          heartbeat_at: string | null
          id: string
          idempotency_key: string
          kind: string
          lease_expires_at: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          media_id: string | null
          next_run_at: string
          payload: Json
          status: string
          survey_id: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "ai_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      complete_ai_media_job: {
        Args: {
          p_actual_usd: number
          p_coverage: string
          p_detections: Json
          p_input_tokens: number
          p_job_id: string
          p_output_tokens: number
          p_provider_deleted?: boolean
          p_quality_flags: Json
          p_quality_warnings: Json
          p_run_id: string
          p_worker: string
        }
        Returns: boolean
      }
      confirm_ai_room: {
        Args: {
          p_actor_id: string
          p_base_updated_at: string
          p_contingency_pct: number
          p_detection_ids: string[]
          p_new_lines: Json
          p_planning_ready: boolean
          p_room_id: string
          p_survey_id: string
          p_total_ft3: number
        }
        Returns: {
          ai_abandoned_at: string | null
          ai_consent: Json | null
          ai_consent_withdrawn_at: string | null
          ai_consent_withdrawn_by: string | null
          ai_status: string
          appointment_id: string | null
          client_id: string | null
          contingency_pct: number
          created_at: string
          created_by: string | null
          customer_notes: string
          id: string
          items: Json
          last_ai_user_activity_at: string | null
          lead_id: string | null
          legal_hold: boolean
          media_retention_anchor_at: string | null
          notes: string
          planning_ready: boolean
          room_manifest_complete: boolean
          share_token: string | null
          status: string
          total_ft3: number
          updated_at: string
          updated_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "cubic_surveys"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fail_ai_job: {
        Args: { p_error: string; p_job_id: string; p_worker: string }
        Returns: {
          attempts: number
          created_at: string
          error: string | null
          heartbeat_at: string | null
          id: string
          idempotency_key: string
          kind: string
          lease_expires_at: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          media_id: string | null
          next_run_at: string
          payload: Json
          status: string
          survey_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "ai_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      finalise_ai_call: {
        Args: { p_actual_usd: number; p_attempt_key: string }
        Returns: boolean
      }
      finalize_ai_media: {
        Args: {
          p_actor_id: string
          p_bytes: number
          p_duration_s: number
          p_frames: Json
          p_media_id: string
          p_prompt_version: string
        }
        Returns: {
          attempts: number
          created_at: string
          error: string | null
          heartbeat_at: string | null
          id: string
          idempotency_key: string
          kind: string
          lease_expires_at: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          media_id: string | null
          next_run_at: string
          payload: Json
          status: string
          survey_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "ai_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      heartbeat_ai_job: {
        Args: { p_job_id: string; p_lease_seconds?: number; p_worker: string }
        Returns: boolean
      }
      complete_ai_room_manually: {
        Args: { p_actor_id: string; p_base_updated_at: string; p_room_id: string; p_survey_id: string }
        Returns: Database["public"]["Tables"]["cubic_surveys"]["Row"]
        SetofOptions: {
          from: "*"
          to: "cubic_surveys"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      ignore_failed_ai_media: {
        Args: { p_actor_id: string; p_media_id: string }
        Returns: boolean
      }
      is_admin: { Args: never; Returns: boolean }
      is_office: { Args: never; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      recompute_ai_room_state: {
        Args: { p_room_id: string }
        Returns: undefined
      }
      release_ai_call: { Args: { p_attempt_key: string }; Returns: boolean }
      release_stale_ai_reservations: {
        Args: { p_age_minutes?: number }
        Returns: number
      }
      retry_ai_job: {
        Args: { p_actor_id: string; p_job_id: string }
        Returns: Database["public"]["Tables"]["ai_jobs"]["Row"]
        SetofOptions: {
          from: "*"
          to: "ai_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      resolve_ai_duplicate_group: {
        Args: { p_actor_id: string; p_choice: string; p_detection_ids: string[]; p_qty: number | null }
        Returns: Json
      }
      reserve_ai_call: {
        Args: {
          p_attempt_key: string
          p_estimated_usd: number
          p_job_id: string
          p_survey_id: string
        }
        Returns: {
          allowed: boolean
          reason: string
          reservation_id: string
        }[]
      }
    }
    Enums: {
      activity_type:
        | "note"
        | "status_change"
        | "call"
        | "email_sent"
        | "sms_sent"
        | "quote_sent"
        | "survey_booked"
        | "merge"
        | "lead_created"
      appt_status: "scheduled" | "completed" | "cancelled"
      appt_type: "survey" | "removal"
      comm_channel: "email" | "sms"
      comm_status: "queued" | "sent" | "failed" | "blocked_duplicate"
      follow_up_outcome:
        | "reached"
        | "no_answer"
        | "no_answer_exhausted"
        | "paid"
        | "declined"
        | "cancelled"
      follow_up_reason:
        | "no_answer"
        | "quote_followup"
        | "deposit"
        | "balance"
        | "custom"
      follow_up_status: "open" | "done" | "cancelled"
      lead_entry_channel:
        | "web"
        | "phone_google"
        | "phone_facebook"
        | "phone_referral"
        | "manual"
        | "referral"
      lead_status:
        | "website_enquiry"
        | "survey_booked"
        | "quoted"
        | "provisional"
        | "confirmed"
        | "completed"
        | "declined"
      photo_category: "access" | "large_items" | "cubic"
      quote_status: "draft" | "sent" | "accepted" | "rejected" | "superseded"
      survey_status: "scheduled" | "completed" | "cancelled"
      user_role: "admin" | "estimator" | "crew"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      activity_type: [
        "note",
        "status_change",
        "call",
        "email_sent",
        "sms_sent",
        "quote_sent",
        "survey_booked",
        "merge",
        "lead_created",
      ],
      appt_status: ["scheduled", "completed", "cancelled"],
      appt_type: ["survey", "removal"],
      comm_channel: ["email", "sms"],
      comm_status: ["queued", "sent", "failed", "blocked_duplicate"],
      follow_up_outcome: [
        "reached",
        "no_answer",
        "no_answer_exhausted",
        "paid",
        "declined",
        "cancelled",
      ],
      follow_up_reason: [
        "no_answer",
        "quote_followup",
        "deposit",
        "balance",
        "custom",
      ],
      follow_up_status: ["open", "done", "cancelled"],
      lead_entry_channel: [
        "web",
        "phone_google",
        "phone_facebook",
        "phone_referral",
        "manual",
        "referral",
      ],
      lead_status: [
        "website_enquiry",
        "survey_booked",
        "quoted",
        "provisional",
        "confirmed",
        "completed",
        "declined",
      ],
      photo_category: ["access", "large_items", "cubic"],
      quote_status: ["draft", "sent", "accepted", "rejected", "superseded"],
      survey_status: ["scheduled", "completed", "cancelled"],
      user_role: ["admin", "estimator", "crew"],
    },
  },
} as const

