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
      auth_passkey_attempts: {
        Row: {
          created_at: string
          credential_id: string
          id: string
        }
        Insert: {
          created_at?: string
          credential_id: string
          id?: string
        }
        Update: {
          created_at?: string
          credential_id?: string
          id?: string
        }
        Relationships: []
      }
      auth_passkey_challenges: {
        Row: {
          challenge: string
          created_at: string
          expires_at: string
          id: string
          kind: string
          user_id: string | null
        }
        Insert: {
          challenge: string
          created_at?: string
          expires_at: string
          id?: string
          kind: string
          user_id?: string | null
        }
        Update: {
          challenge?: string
          created_at?: string
          expires_at?: string
          id?: string
          kind?: string
          user_id?: string | null
        }
        Relationships: []
      }
      auth_passkeys: {
        Row: {
          counter: number
          created_at: string
          credential_id: string
          device_label: string | null
          id: string
          last_used_at: string | null
          public_key: string
          transports: string | null
          user_id: string
        }
        Insert: {
          counter?: number
          created_at?: string
          credential_id: string
          device_label?: string | null
          id?: string
          last_used_at?: string | null
          public_key: string
          transports?: string | null
          user_id: string
        }
        Update: {
          counter?: number
          created_at?: string
          credential_id?: string
          device_label?: string | null
          id?: string
          last_used_at?: string | null
          public_key?: string
          transports?: string | null
          user_id?: string
        }
        Relationships: []
      }
      bank_transactions: {
        Row: {
          amount: number
          confirmed_at: string | null
          counterparty: string | null
          created_at: string
          currency: string | null
          description: string | null
          id: string
          match_confidence: string | null
          match_kind: string | null
          matched_quote_id: string | null
          raw: Json
          reference: string | null
          status: string
          transaction_id: string
          tx_date: string
          tx_time: string | null
          tx_type: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          confirmed_at?: string | null
          counterparty?: string | null
          created_at?: string
          currency?: string | null
          description?: string | null
          id?: string
          match_confidence?: string | null
          match_kind?: string | null
          matched_quote_id?: string | null
          raw?: Json
          reference?: string | null
          status?: string
          transaction_id: string
          tx_date: string
          tx_time?: string | null
          tx_type?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          confirmed_at?: string | null
          counterparty?: string | null
          created_at?: string
          currency?: string | null
          description?: string | null
          id?: string
          match_confidence?: string | null
          match_kind?: string | null
          matched_quote_id?: string | null
          raw?: Json
          reference?: string | null
          status?: string
          transaction_id?: string
          tx_date?: string
          tx_time?: string | null
          tx_type?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_transactions_matched_quote_id_fkey"
            columns: ["matched_quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_details: {
        Row: {
          approx_month: string | null
          approx_window: string | null
          created_at: string
          lead_id: string
          property_type: string | null
          provisional_date: string | null
          updated_at: string
        }
        Insert: {
          approx_month?: string | null
          approx_window?: string | null
          created_at?: string
          lead_id: string
          property_type?: string | null
          provisional_date?: string | null
          updated_at?: string
        }
        Update: {
          approx_month?: string | null
          approx_window?: string | null
          created_at?: string
          lead_id?: string
          property_type?: string | null
          provisional_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_details_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "leads"
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
          card_payments_enabled: boolean
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
          estimator_commission_pct: number
          estimator_fee: number
          estimator_phone_quote_fee: number
          fleet_alert_recipients: string[]
          fleet_reminders_enabled: boolean
          google_review_url: string
          id: boolean
          pricing: Json | null
          push_crew_job_enabled: boolean
          push_enabled: boolean
          push_fleet_expiry_enabled: boolean
          push_new_enquiry_enabled: boolean
          push_payment_event_enabled: boolean
          self_billing_enabled: boolean
          staff_onboard_enabled: boolean
          staff_onboard_token: string | null
          storage_rates: Json | null
          updated_at: string
          vat_default: boolean
          vat_flat_rate_pct: number
          vat_number: string | null
          vat_scheme: string
          vat_stagger_group: number
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
          card_payments_enabled?: boolean
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
          estimator_commission_pct?: number
          estimator_fee?: number
          estimator_phone_quote_fee?: number
          fleet_alert_recipients?: string[]
          fleet_reminders_enabled?: boolean
          google_review_url?: string
          id?: boolean
          pricing?: Json | null
          push_crew_job_enabled?: boolean
          push_enabled?: boolean
          push_fleet_expiry_enabled?: boolean
          push_new_enquiry_enabled?: boolean
          push_payment_event_enabled?: boolean
          self_billing_enabled?: boolean
          staff_onboard_enabled?: boolean
          staff_onboard_token?: string | null
          storage_rates?: Json | null
          updated_at?: string
          vat_default?: boolean
          vat_flat_rate_pct?: number
          vat_number?: string | null
          vat_scheme?: string
          vat_stagger_group?: number
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
          card_payments_enabled?: boolean
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
          estimator_commission_pct?: number
          estimator_fee?: number
          estimator_phone_quote_fee?: number
          fleet_alert_recipients?: string[]
          fleet_reminders_enabled?: boolean
          google_review_url?: string
          id?: boolean
          pricing?: Json | null
          push_crew_job_enabled?: boolean
          push_enabled?: boolean
          push_fleet_expiry_enabled?: boolean
          push_new_enquiry_enabled?: boolean
          push_payment_event_enabled?: boolean
          self_billing_enabled?: boolean
          staff_onboard_enabled?: boolean
          staff_onboard_token?: string | null
          storage_rates?: Json | null
          updated_at?: string
          vat_default?: boolean
          vat_flat_rate_pct?: number
          vat_number?: string | null
          vat_scheme?: string
          vat_stagger_group?: number
        }
        Relationships: []
      }
      card_payments: {
        Row: {
          amount_pence: number
          authorisation_code: string | null
          card_number_mask: string | null
          card_scheme: string | null
          client_id: string | null
          created_at: string
          gateway_transaction_id: string | null
          gateway_xref: string | null
          id: string
          is_test: boolean
          kind: string
          lead_id: string | null
          quote_id: string
          reconcile_alerted_at: string | null
          refund_reason: string | null
          refunded_at: string | null
          refunded_by: string | null
          refunded_pence: number
          response_code: number | null
          response_message: string | null
          settled_at: string | null
          status: string
          zoho_credit_note_id: string | null
          zoho_credit_note_number: string | null
        }
        Insert: {
          amount_pence: number
          authorisation_code?: string | null
          card_number_mask?: string | null
          card_scheme?: string | null
          client_id?: string | null
          created_at?: string
          gateway_transaction_id?: string | null
          gateway_xref?: string | null
          id?: string
          is_test?: boolean
          kind?: string
          lead_id?: string | null
          quote_id: string
          reconcile_alerted_at?: string | null
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          refunded_pence?: number
          response_code?: number | null
          response_message?: string | null
          settled_at?: string | null
          status?: string
          zoho_credit_note_id?: string | null
          zoho_credit_note_number?: string | null
        }
        Update: {
          amount_pence?: number
          authorisation_code?: string | null
          card_number_mask?: string | null
          card_scheme?: string | null
          client_id?: string | null
          created_at?: string
          gateway_transaction_id?: string | null
          gateway_xref?: string | null
          id?: string
          is_test?: boolean
          kind?: string
          lead_id?: string | null
          quote_id?: string
          reconcile_alerted_at?: string | null
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          refunded_pence?: number
          response_code?: number | null
          response_message?: string | null
          settled_at?: string | null
          status?: string
          zoho_credit_note_id?: string | null
          zoho_credit_note_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "card_payments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_payments_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_payments_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_payments_refunded_by_fkey"
            columns: ["refunded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      claims: {
        Row: {
          claim_no: number
          client_id: string | null
          closed_at: string | null
          completion_id: string | null
          created_at: string
          description: string
          id: string
          insurer_notified_at: string | null
          insurer_ref: string
          lead_id: string
          notes: string
          opened_by: string | null
          reported_at: string
          reported_channel: string
          resolution: string | null
          resolution_amount: number | null
          status: string
          updated_at: string
        }
        Insert: {
          claim_no?: never
          client_id?: string | null
          closed_at?: string | null
          completion_id?: string | null
          created_at?: string
          description: string
          id?: string
          insurer_notified_at?: string | null
          insurer_ref?: string
          lead_id: string
          notes?: string
          opened_by?: string | null
          reported_at?: string
          reported_channel?: string
          resolution?: string | null
          resolution_amount?: number | null
          status?: string
          updated_at?: string
        }
        Update: {
          claim_no?: never
          client_id?: string | null
          closed_at?: string | null
          completion_id?: string | null
          created_at?: string
          description?: string
          id?: string
          insurer_notified_at?: string | null
          insurer_ref?: string
          lead_id?: string
          notes?: string
          opened_by?: string | null
          reported_at?: string
          reported_channel?: string
          resolution?: string | null
          resolution_amount?: number | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claims_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_completion_id_fkey"
            columns: ["completion_id"]
            isOneToOne: false
            referencedRelation: "job_completions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_opened_by_fkey"
            columns: ["opened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
          import_batch: string | null
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
          import_batch?: string | null
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
          import_batch?: string | null
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
          attempt_count: number
          body: string
          channel: Database["public"]["Enums"]["comm_channel"]
          claim_expires_at: string | null
          claim_token: string | null
          client_id: string | null
          content_hash: string
          created_at: string
          direction: string
          dispatch_key: string | null
          first_sent_at: string | null
          id: string
          is_override: boolean
          last_sent_at: string | null
          lead_id: string | null
          override_reason: string | null
          provider: string | null
          provider_error: string | null
          provider_id: string | null
          provider_outcome_unknown: boolean
          provider_payload_hash: string | null
          provider_started_at: string | null
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
          attempt_count?: number
          body: string
          channel: Database["public"]["Enums"]["comm_channel"]
          claim_expires_at?: string | null
          claim_token?: string | null
          client_id?: string | null
          content_hash: string
          created_at?: string
          direction?: string
          dispatch_key?: string | null
          first_sent_at?: string | null
          id?: string
          is_override?: boolean
          last_sent_at?: string | null
          lead_id?: string | null
          override_reason?: string | null
          provider?: string | null
          provider_error?: string | null
          provider_id?: string | null
          provider_outcome_unknown?: boolean
          provider_payload_hash?: string | null
          provider_started_at?: string | null
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
          attempt_count?: number
          body?: string
          channel?: Database["public"]["Enums"]["comm_channel"]
          claim_expires_at?: string | null
          claim_token?: string | null
          client_id?: string | null
          content_hash?: string
          created_at?: string
          direction?: string
          dispatch_key?: string | null
          first_sent_at?: string | null
          id?: string
          is_override?: boolean
          last_sent_at?: string | null
          lead_id?: string | null
          override_reason?: string | null
          provider?: string | null
          provider_error?: string | null
          provider_id?: string | null
          provider_outcome_unknown?: boolean
          provider_payload_hash?: string | null
          provider_started_at?: string | null
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
      contractor_agreements: {
        Row: {
          acknowledgments: Json
          agreement_version: string
          created_at: string
          id: string
          ip: string | null
          profile_id: string
          role: string
          signature_data: string | null
          signed_at: string
          signer_name: string
          staff_id: string | null
          user_agent: string | null
        }
        Insert: {
          acknowledgments?: Json
          agreement_version: string
          created_at?: string
          id?: string
          ip?: string | null
          profile_id: string
          role: string
          signature_data?: string | null
          signed_at?: string
          signer_name: string
          staff_id?: string | null
          user_agent?: string | null
        }
        Update: {
          acknowledgments?: Json
          agreement_version?: string
          created_at?: string
          id?: string
          ip?: string | null
          profile_id?: string
          role?: string
          signature_data?: string | null
          signed_at?: string
          signer_name?: string
          staff_id?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contractor_agreements_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_agreements_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      crew_job_sheet_sends: {
        Row: {
          channel: string
          created_at: string
          error: string | null
          id: string
          provider_id: string | null
          recipient: string | null
          sheet_id: string
          status: string
          superseding: boolean
          version: number
        }
        Insert: {
          channel: string
          created_at?: string
          error?: string | null
          id?: string
          provider_id?: string | null
          recipient?: string | null
          sheet_id: string
          status: string
          superseding?: boolean
          version: number
        }
        Update: {
          channel?: string
          created_at?: string
          error?: string | null
          id?: string
          provider_id?: string | null
          recipient?: string | null
          sheet_id?: string
          status?: string
          superseding?: boolean
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "crew_job_sheet_sends_sheet_id_fkey"
            columns: ["sheet_id"]
            isOneToOne: false
            referencedRelation: "crew_job_sheets"
            referencedColumns: ["id"]
          },
        ]
      }
      crew_job_sheets: {
        Row: {
          attempts: number
          content_hash: string
          created_at: string
          delivered_at: string | null
          delivered_hash: string | null
          id: string
          staff_id: string
          token: string
          updated_at: string
          version: number
          work_date: string
        }
        Insert: {
          attempts?: number
          content_hash: string
          created_at?: string
          delivered_at?: string | null
          delivered_hash?: string | null
          id?: string
          staff_id: string
          token: string
          updated_at?: string
          version?: number
          work_date: string
        }
        Update: {
          attempts?: number
          content_hash?: string
          created_at?: string
          delivered_at?: string | null
          delivered_hash?: string | null
          id?: string
          staff_id?: string
          token?: string
          updated_at?: string
          version?: number
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "crew_job_sheets_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_runs: {
        Row: {
          created_at: string
          duration_ms: number | null
          error: string | null
          finished_at: string
          id: string
          job: string
          started_at: string
          status: string
          summary: Json
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          finished_at?: string
          id?: string
          job: string
          started_at: string
          status: string
          summary?: Json
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          finished_at?: string
          id?: string
          job?: string
          started_at?: string
          status?: string
          summary?: Json
        }
        Relationships: []
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
      growth_artifacts: {
        Row: {
          artifact_type: string
          brand: string
          generated_at: string | null
          id: string
          payload: Json
          pushed_at: string
          source_host: string | null
        }
        Insert: {
          artifact_type: string
          brand: string
          generated_at?: string | null
          id?: string
          payload: Json
          pushed_at?: string
          source_host?: string | null
        }
        Update: {
          artifact_type?: string
          brand?: string
          generated_at?: string | null
          id?: string
          payload?: Json
          pushed_at?: string
          source_host?: string | null
        }
        Relationships: []
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
      job_media: {
        Row: {
          appointment_id: string | null
          attached_to: string | null
          bytes: number | null
          caption: string
          captured_by: string | null
          captured_by_name: string
          client_id: string | null
          consent_state: string
          created_at: string
          duration_s: number | null
          id: string
          kind: string
          lead_id: string
          marketing_approved_at: string | null
          marketing_approved_by: string | null
          mime: string | null
          storage_path: string
          synced_at: string | null
          tag: string | null
          transcript: string | null
          transcript_attempts: number
          transcript_error: string | null
          transcript_status: string
          updated_at: string
        }
        Insert: {
          appointment_id?: string | null
          attached_to?: string | null
          bytes?: number | null
          caption?: string
          captured_by?: string | null
          captured_by_name?: string
          client_id?: string | null
          consent_state?: string
          created_at?: string
          duration_s?: number | null
          id?: string
          kind: string
          lead_id: string
          marketing_approved_at?: string | null
          marketing_approved_by?: string | null
          mime?: string | null
          storage_path: string
          synced_at?: string | null
          tag?: string | null
          transcript?: string | null
          transcript_attempts?: number
          transcript_error?: string | null
          transcript_status?: string
          updated_at?: string
        }
        Update: {
          appointment_id?: string | null
          attached_to?: string | null
          bytes?: number | null
          caption?: string
          captured_by?: string | null
          captured_by_name?: string
          client_id?: string | null
          consent_state?: string
          created_at?: string
          duration_s?: number | null
          id?: string
          kind?: string
          lead_id?: string
          marketing_approved_at?: string | null
          marketing_approved_by?: string | null
          mime?: string | null
          storage_path?: string
          synced_at?: string | null
          tag?: string | null
          transcript?: string | null
          transcript_attempts?: number
          transcript_error?: string | null
          transcript_status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_media_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_media_attached_to_fkey"
            columns: ["attached_to"]
            isOneToOne: false
            referencedRelation: "job_media"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_media_captured_by_fkey"
            columns: ["captured_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_media_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_media_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_media_marketing_approved_by_fkey"
            columns: ["marketing_approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
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
          date_confirm_signature_id: string | null
          date_confirmed_at: string | null
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
          import_batch: string | null
          landing_referrer: string | null
          landing_url: string | null
          li_fat_id: string | null
          lost_at: string | null
          lost_note: string | null
          lost_reason: string | null
          media_consent: string
          msclkid: string | null
          name: string | null
          notes: string | null
          phone: string | null
          posthog_distinct_id: string | null
          preferred_date: string | null
          property_size: string | null
          quote_chase_at: string | null
          quote_chase_step: number
          referral_commission: number | null
          referrer_answer: string | null
          review_requested_at: string | null
          review_suppressed: boolean
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
          web_alert_ack_at: string | null
        }
        Insert: {
          balance_amount?: number | null
          balance_due_date?: string | null
          balance_paid_at?: string | null
          campaign?: string | null
          chase_paused?: boolean
          client_id: string
          created_at?: string
          date_confirm_signature_id?: string | null
          date_confirmed_at?: string | null
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
          import_batch?: string | null
          landing_referrer?: string | null
          landing_url?: string | null
          li_fat_id?: string | null
          lost_at?: string | null
          lost_note?: string | null
          lost_reason?: string | null
          media_consent?: string
          msclkid?: string | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          posthog_distinct_id?: string | null
          preferred_date?: string | null
          property_size?: string | null
          quote_chase_at?: string | null
          quote_chase_step?: number
          referral_commission?: number | null
          referrer_answer?: string | null
          review_requested_at?: string | null
          review_suppressed?: boolean
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
          web_alert_ack_at?: string | null
        }
        Update: {
          balance_amount?: number | null
          balance_due_date?: string | null
          balance_paid_at?: string | null
          campaign?: string | null
          chase_paused?: boolean
          client_id?: string
          created_at?: string
          date_confirm_signature_id?: string | null
          date_confirmed_at?: string | null
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
          import_batch?: string | null
          landing_referrer?: string | null
          landing_url?: string | null
          li_fat_id?: string | null
          lost_at?: string | null
          lost_note?: string | null
          lost_reason?: string | null
          media_consent?: string
          msclkid?: string | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          posthog_distinct_id?: string | null
          preferred_date?: string | null
          property_size?: string | null
          quote_chase_at?: string | null
          quote_chase_step?: number
          referral_commission?: number | null
          referrer_answer?: string | null
          review_requested_at?: string | null
          review_suppressed?: boolean
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
          web_alert_ack_at?: string | null
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
            foreignKeyName: "leads_date_confirm_signature_id_fkey"
            columns: ["date_confirm_signature_id"]
            isOneToOne: false
            referencedRelation: "signatures"
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
      operational_issue_daily_digests: {
        Row: {
          attempt_count: number
          claim_expires_at: string | null
          claim_token: string | null
          issue_count: number
          payload: Json
          payload_hash: string
          provider_error: string | null
          sent_at: string | null
          snapshot_date: string
          status: string
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          claim_expires_at?: string | null
          claim_token?: string | null
          issue_count?: number
          payload?: Json
          payload_hash?: string
          provider_error?: string | null
          sent_at?: string | null
          snapshot_date: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          claim_expires_at?: string | null
          claim_token?: string | null
          issue_count?: number
          payload?: Json
          payload_hash?: string
          provider_error?: string | null
          sent_at?: string | null
          snapshot_date?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      operational_issue_daily_updates: {
        Row: {
          context: Json
          created_at: string
          id: string
          issue_id: string
          occurrence_count: number
          severity: string
          snapshot_date: string
          status: string
          updated_at: string
        }
        Insert: {
          context?: Json
          created_at?: string
          id?: string
          issue_id: string
          occurrence_count: number
          severity: string
          snapshot_date: string
          status: string
          updated_at?: string
        }
        Update: {
          context?: Json
          created_at?: string
          id?: string
          issue_id?: string
          occurrence_count?: number
          severity?: string
          snapshot_date?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operational_issue_daily_updates_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "operational_issues"
            referencedColumns: ["id"]
          },
        ]
      }
      operational_issues: {
        Row: {
          context: Json
          event: string
          first_seen_at: string
          id: string
          issue_key: string
          last_checkpoint_at: string | null
          last_seen_at: string
          message: string
          occurrence_count: number
          resolved_at: string | null
          severity: string
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          context?: Json
          event: string
          first_seen_at?: string
          id?: string
          issue_key: string
          last_checkpoint_at?: string | null
          last_seen_at?: string
          message: string
          occurrence_count?: number
          resolved_at?: string | null
          severity: string
          source: string
          status?: string
          updated_at?: string
        }
        Update: {
          context?: Json
          event?: string
          first_seen_at?: string
          id?: string
          issue_key?: string
          last_checkpoint_at?: string | null
          last_seen_at?: string
          message?: string
          occurrence_count?: number
          resolved_at?: string | null
          severity?: string
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          active: boolean
          created_at: string
          email: string | null
          full_name: string
          id: string
          role: Database["public"]["Enums"]["user_role"]
          tour_seen_at: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          email?: string | null
          full_name?: string
          id: string
          role?: Database["public"]["Enums"]["user_role"]
          tour_seen_at?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
          tour_seen_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      push_preferences: {
        Row: {
          categories: Json
          created_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          categories?: Json
          created_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          categories?: Json
          created_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth_secret: string
          created_at: string
          endpoint: string
          endpoint_hash: string
          expiration_time: string | null
          failure_count: number
          id: string
          installation_id: string | null
          last_failure_at: string | null
          last_seen_at: string | null
          last_success_at: string | null
          p256dh: string
          revoked_at: string | null
          status: string
          updated_at: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth_secret: string
          created_at?: string
          endpoint: string
          endpoint_hash: string
          expiration_time?: string | null
          failure_count?: number
          id?: string
          installation_id?: string | null
          last_failure_at?: string | null
          last_seen_at?: string | null
          last_success_at?: string | null
          p256dh: string
          revoked_at?: string | null
          status?: string
          updated_at?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth_secret?: string
          created_at?: string
          endpoint?: string
          endpoint_hash?: string
          expiration_time?: string | null
          failure_count?: number
          id?: string
          installation_id?: string | null
          last_failure_at?: string | null
          last_seen_at?: string | null
          last_success_at?: string | null
          p256dh?: string
          revoked_at?: string | null
          status?: string
          updated_at?: string
          user_agent?: string | null
          user_id?: string
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
          booking_cancelled_at: string | null
          breakdown: Json
          client_id: string | null
          collect_addr: string | null
          commitment_chase_t10_at: string | null
          commitment_due_date: string | null
          commitment_invoice_amount: number | null
          commitment_invoice_created_at: string | null
          commitment_paid_at: string | null
          commitment_paid_method: string | null
          created_at: string
          customer_email: string | null
          customer_name: string | null
          customer_phone: string | null
          date_releasable_at: string | null
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
          imve_ref: string | null
          imve_zoho_invoice_number: string | null
          lead_id: string | null
          moving_date: string | null
          moving_date_estimated: boolean
          packing: string | null
          pdf_path: string | null
          quote_ref: string
          sms_send_count: number
          source: string
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
          zoho_commitment_error: string | null
          zoho_commitment_invoice_id: string | null
          zoho_commitment_invoice_number: string | null
          zoho_commitment_invoice_url: string | null
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
          booking_cancelled_at?: string | null
          breakdown?: Json
          client_id?: string | null
          collect_addr?: string | null
          commitment_chase_t10_at?: string | null
          commitment_due_date?: string | null
          commitment_invoice_amount?: number | null
          commitment_invoice_created_at?: string | null
          commitment_paid_at?: string | null
          commitment_paid_method?: string | null
          created_at?: string
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          date_releasable_at?: string | null
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
          imve_ref?: string | null
          imve_zoho_invoice_number?: string | null
          lead_id?: string | null
          moving_date?: string | null
          moving_date_estimated?: boolean
          packing?: string | null
          pdf_path?: string | null
          quote_ref: string
          sms_send_count?: number
          source?: string
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
          zoho_commitment_error?: string | null
          zoho_commitment_invoice_id?: string | null
          zoho_commitment_invoice_number?: string | null
          zoho_commitment_invoice_url?: string | null
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
          booking_cancelled_at?: string | null
          breakdown?: Json
          client_id?: string | null
          collect_addr?: string | null
          commitment_chase_t10_at?: string | null
          commitment_due_date?: string | null
          commitment_invoice_amount?: number | null
          commitment_invoice_created_at?: string | null
          commitment_paid_at?: string | null
          commitment_paid_method?: string | null
          created_at?: string
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          date_releasable_at?: string | null
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
          imve_ref?: string | null
          imve_zoho_invoice_number?: string | null
          lead_id?: string | null
          moving_date?: string | null
          moving_date_estimated?: boolean
          packing?: string | null
          pdf_path?: string | null
          quote_ref?: string
          sms_send_count?: number
          source?: string
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
          zoho_commitment_error?: string | null
          zoho_commitment_invoice_id?: string | null
          zoho_commitment_invoice_number?: string | null
          zoho_commitment_invoice_url?: string | null
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
      refund_queue: {
        Row: {
          cash_recipient_account: string | null
          cash_recipient_name: string | null
          cash_recipient_sort: string | null
          conditional_amount: number
          created_at: string
          determination: string | null
          determined_at: string | null
          determined_by: string | null
          executed_at: string | null
          executed_by: string | null
          held: Json
          id: string
          lead_id: string | null
          new_appointment_id: string | null
          notes: string | null
          old_appointment_id: string | null
          original_move_date: string | null
          quote_id: string | null
          shortfall_note: string | null
          status: string
          trigger: string
          unconditional_amount: number
        }
        Insert: {
          cash_recipient_account?: string | null
          cash_recipient_name?: string | null
          cash_recipient_sort?: string | null
          conditional_amount?: number
          created_at?: string
          determination?: string | null
          determined_at?: string | null
          determined_by?: string | null
          executed_at?: string | null
          executed_by?: string | null
          held?: Json
          id?: string
          lead_id?: string | null
          new_appointment_id?: string | null
          notes?: string | null
          old_appointment_id?: string | null
          original_move_date?: string | null
          quote_id?: string | null
          shortfall_note?: string | null
          status?: string
          trigger: string
          unconditional_amount?: number
        }
        Update: {
          cash_recipient_account?: string | null
          cash_recipient_name?: string | null
          cash_recipient_sort?: string | null
          conditional_amount?: number
          created_at?: string
          determination?: string | null
          determined_at?: string | null
          determined_by?: string | null
          executed_at?: string | null
          executed_by?: string | null
          held?: Json
          id?: string
          lead_id?: string | null
          new_appointment_id?: string | null
          notes?: string | null
          old_appointment_id?: string | null
          original_move_date?: string | null
          quote_id?: string | null
          shortfall_note?: string | null
          status?: string
          trigger?: string
          unconditional_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "refund_queue_determined_by_fkey"
            columns: ["determined_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_queue_executed_by_fkey"
            columns: ["executed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_queue_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_queue_new_appointment_id_fkey"
            columns: ["new_appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_queue_old_appointment_id_fkey"
            columns: ["old_appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_queue_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      signatures: {
        Row: {
          ack_labels: Json | null
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
          ack_labels?: Json | null
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
          ack_labels?: Json | null
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
          address: string | null
          created_at: string
          date_of_birth: string | null
          day_rate: number | null
          email: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          full_name: string
          id: string
          is_active: boolean
          is_driver: boolean
          notes: string | null
          phone: string | null
          profile_id: string | null
          staff_role: string
          updated_at: string
          working_days: number[]
        }
        Insert: {
          address?: string | null
          created_at?: string
          date_of_birth?: string | null
          day_rate?: number | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          full_name: string
          id?: string
          is_active?: boolean
          is_driver?: boolean
          notes?: string | null
          phone?: string | null
          profile_id?: string | null
          staff_role?: string
          updated_at?: string
          working_days?: number[]
        }
        Update: {
          address?: string | null
          created_at?: string
          date_of_birth?: string | null
          day_rate?: number | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          full_name?: string
          id?: string
          is_active?: boolean
          is_driver?: boolean
          notes?: string | null
          phone?: string | null
          profile_id?: string | null
          staff_role?: string
          updated_at?: string
          working_days?: number[]
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
      staff_availability: {
        Row: {
          created_at: string
          created_by: string | null
          date: string
          id: string
          note: string | null
          staff_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          date: string
          id?: string
          note?: string | null
          staff_id: string
          status: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          date?: string
          id?: string
          note?: string | null
          staff_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_availability_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_availability_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_pay: {
        Row: {
          created_at: string
          hourly_rate: number | null
          staff_id: string
          updated_at: string
          weekly_guarantee: number | null
        }
        Insert: {
          created_at?: string
          hourly_rate?: number | null
          staff_id: string
          updated_at?: string
          weekly_guarantee?: number | null
        }
        Update: {
          created_at?: string
          hourly_rate?: number | null
          staff_id?: string
          updated_at?: string
          weekly_guarantee?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_pay_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: true
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_statement_lines: {
        Row: {
          amount: number
          appointment_id: string | null
          created_at: string
          description: string
          id: string
          lead_id: string | null
          quantity: number | null
          sort_index: number
          source: string
          statement_id: string
          unit_amount: number | null
          updated_at: string
          work_date: string | null
        }
        Insert: {
          amount?: number
          appointment_id?: string | null
          created_at?: string
          description: string
          id?: string
          lead_id?: string | null
          quantity?: number | null
          sort_index?: number
          source?: string
          statement_id: string
          unit_amount?: number | null
          updated_at?: string
          work_date?: string | null
        }
        Update: {
          amount?: number
          appointment_id?: string | null
          created_at?: string
          description?: string
          id?: string
          lead_id?: string | null
          quantity?: number | null
          sort_index?: number
          source?: string
          statement_id?: string
          unit_amount?: number | null
          updated_at?: string
          work_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_statement_lines_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_statement_lines_statement_id_fkey"
            columns: ["statement_id"]
            isOneToOne: false
            referencedRelation: "staff_statements"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_statements: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          paid_at: string | null
          paid_method: string | null
          paid_ref: string | null
          pdf_path: string | null
          period_end: string
          period_start: string
          ref: string
          return_reason: string | null
          returned_at: string | null
          staff_id: string
          status: string
          submitted_at: string | null
          total: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          paid_at?: string | null
          paid_method?: string | null
          paid_ref?: string | null
          pdf_path?: string | null
          period_end: string
          period_start: string
          ref: string
          return_reason?: string | null
          returned_at?: string | null
          staff_id: string
          status?: string
          submitted_at?: string | null
          total?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          paid_at?: string | null
          paid_method?: string | null
          paid_ref?: string | null
          pdf_path?: string | null
          period_end?: string
          period_start?: string
          ref?: string
          return_reason?: string | null
          returned_at?: string | null
          staff_id?: string
          status?: string
          submitted_at?: string | null
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_statements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_statements_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_submissions: {
        Row: {
          address: string | null
          address_country: string | null
          address_county: string | null
          address_line1: string | null
          address_postcode: string | null
          address_town: string | null
          created_at: string
          date_of_birth: string | null
          email: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          full_name: string
          id: string
          is_driver: boolean
          notes: string | null
          phone: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          staff_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          address_country?: string | null
          address_county?: string | null
          address_line1?: string | null
          address_postcode?: string | null
          address_town?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          full_name: string
          id?: string
          is_driver?: boolean
          notes?: string | null
          phone?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          staff_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          address_country?: string | null
          address_county?: string | null
          address_line1?: string | null
          address_postcode?: string | null
          address_town?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          full_name?: string
          id?: string
          is_driver?: boolean
          notes?: string | null
          phone?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          staff_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_submissions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_submissions_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      storage_handling_events: {
        Row: {
          amount: number
          billed_invoice_id: string | null
          client_id: string | null
          created_at: string
          created_by: string | null
          event_date: string
          id: string
          kind: string
          let_id: string
          notes: string | null
        }
        Insert: {
          amount: number
          billed_invoice_id?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          event_date: string
          id?: string
          kind: string
          let_id: string
          notes?: string | null
        }
        Update: {
          amount?: number
          billed_invoice_id?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          event_date?: string
          id?: string
          kind?: string
          let_id?: string
          notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "storage_handling_events_billed_invoice_id_fkey"
            columns: ["billed_invoice_id"]
            isOneToOne: false
            referencedRelation: "storage_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storage_handling_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storage_handling_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storage_handling_events_let_id_fkey"
            columns: ["let_id"]
            isOneToOne: false
            referencedRelation: "storage_lets"
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
          handling_amount: number
          handling_event_ids: string[]
          id: string
          kind: string
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
          handling_amount?: number
          handling_event_ids?: string[]
          id?: string
          kind?: string
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
          handling_amount?: number
          handling_event_ids?: string[]
          id?: string
          kind?: string
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
          billing_model: string
          billing_paused: boolean
          client_id: string
          created_at: string
          end_date: string | null
          id: string
          lead_id: string | null
          min_amount: number | null
          min_days: number | null
          notes: string | null
          rate: number | null
          rate_period: string
          sign_token: string | null
          start_date: string
          unit_id: string
          updated_at: string
        }
        Insert: {
          billing_model?: string
          billing_paused?: boolean
          client_id: string
          created_at?: string
          end_date?: string | null
          id?: string
          lead_id?: string | null
          min_amount?: number | null
          min_days?: number | null
          notes?: string | null
          rate?: number | null
          rate_period?: string
          sign_token?: string | null
          start_date: string
          unit_id: string
          updated_at?: string
        }
        Update: {
          billing_model?: string
          billing_paused?: boolean
          client_id?: string
          created_at?: string
          end_date?: string | null
          id?: string
          lead_id?: string | null
          min_amount?: number | null
          min_days?: number | null
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
      storage_supplier_rates: {
        Row: {
          data: Json
          id: boolean
          updated_at: string
        }
        Insert: {
          data?: Json
          id?: boolean
          updated_at?: string
        }
        Update: {
          data?: Json
          id?: boolean
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
      vehicle_reminder_log: {
        Row: {
          due_date: string
          expiry_type: string
          id: string
          sent_at: string
          threshold: string
          vehicle_id: string
        }
        Insert: {
          due_date: string
          expiry_type: string
          id?: string
          sent_at?: string
          threshold: string
          vehicle_id: string
        }
        Update: {
          due_date?: string
          expiry_type?: string
          id?: string
          sent_at?: string
          threshold?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_reminder_log_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_unavailability: {
        Row: {
          created_at: string
          created_by: string | null
          end_date: string
          id: string
          note: string | null
          reason: string
          start_date: string
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          end_date: string
          id?: string
          note?: string | null
          reason?: string
          start_date: string
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          end_date?: string
          id?: string
          note?: string | null
          reason?: string
          start_date?: string
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_unavailability_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_unavailability_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
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
          service_due: string | null
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
          service_due?: string | null
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
          service_due?: string | null
          tax_due?: string | null
          updated_at?: string
          vehicle_type?: string
        }
        Relationships: []
      }
      webhook_delivery_steps: {
        Row: {
          event_id: string
          payload_hash: string
          provider: string
          provider_completed_at: string | null
          provider_id: string | null
          provider_started_at: string
          status: string
          step: string
        }
        Insert: {
          event_id: string
          payload_hash?: string
          provider: string
          provider_completed_at?: string | null
          provider_id?: string | null
          provider_started_at?: string
          status?: string
          step: string
        }
        Update: {
          event_id?: string
          payload_hash?: string
          provider?: string
          provider_completed_at?: string | null
          provider_id?: string | null
          provider_started_at?: string
          status?: string
          step?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_delivery_steps_provider_event_id_fkey"
            columns: ["provider", "event_id"]
            isOneToOne: false
            referencedRelation: "webhook_receipts"
            referencedColumns: ["provider", "event_id"]
          },
        ]
      }
      webhook_receipts: {
        Row: {
          attempt_count: number
          completed_at: string | null
          event_id: string
          event_type: string
          first_received_at: string
          last_error: string | null
          last_received_at: string
          lease_expires_at: string | null
          lease_token: string | null
          outcome: Json
          payload_hash: string
          provider: string
          status: string
        }
        Insert: {
          attempt_count?: number
          completed_at?: string | null
          event_id: string
          event_type: string
          first_received_at?: string
          last_error?: string | null
          last_received_at?: string
          lease_expires_at?: string | null
          lease_token?: string | null
          outcome?: Json
          payload_hash: string
          provider: string
          status?: string
        }
        Update: {
          attempt_count?: number
          completed_at?: string | null
          event_id?: string
          event_type?: string
          first_received_at?: string
          last_error?: string | null
          last_received_at?: string
          lease_expires_at?: string | null
          lease_token?: string | null
          outcome?: Json
          payload_hash?: string
          provider?: string
          status?: string
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
          p_new_room: string
          p_room_id: string
          p_segment_id: string
        }
        Returns: Json
      }
      checkpoint_operational_issues: {
        Args: { p_snapshot_date: string }
        Returns: number
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
      claim_operational_issue_digest: {
        Args: {
          p_issue_count: number
          p_lease_seconds?: number
          p_payload: Json
          p_payload_hash: string
          p_retry_simulated?: boolean
          p_snapshot_date: string
        }
        Returns: {
          decision: string
          digest_attempt_count: number
          digest_claim_token: string
          digest_issue_count: number
          digest_payload: Json
        }[]
      }
      claim_webhook_delivery_step: {
        Args: {
          p_event_id: string
          p_lease_token: string
          p_payload_hash: string
          p_provider: string
          p_step: string
        }
        Returns: {
          decision: string
          provider_id: string
          provider_started_at: string
        }[]
      }
      claim_webhook_event: {
        Args: {
          p_event_id: string
          p_event_type: string
          p_lease_seconds?: number
          p_payload_hash: string
          p_provider: string
        }
        Returns: {
          attempt_count: number
          decision: string
          lease_token: string
        }[]
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
      complete_ai_room_manually: {
        Args: {
          p_actor_id: string
          p_base_updated_at: string
          p_room_id: string
          p_survey_id: string
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
      complete_operational_issue_digest: {
        Args: { p_claim_token: string; p_snapshot_date: string }
        Returns: boolean
      }
      complete_webhook_delivery_step: {
        Args: {
          p_event_id: string
          p_provider: string
          p_provider_id: string
          p_step: string
        }
        Returns: boolean
      }
      complete_webhook_event: {
        Args: {
          p_event_id: string
          p_lease_token: string
          p_outcome?: Json
          p_provider: string
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
      crew_can_access_appointment_object: {
        Args: { p_object_name: string }
        Returns: boolean
      }
      crew_can_access_lead_object: {
        Args: { p_object_name: string }
        Returns: boolean
      }
      crew_can_access_survey_object: {
        Args: { p_object_name: string }
        Returns: boolean
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
      fail_operational_issue_digest: {
        Args: {
          p_claim_token: string
          p_error: string
          p_snapshot_date: string
        }
        Returns: boolean
      }
      fail_webhook_delivery_step: {
        Args: {
          p_event_id: string
          p_lease_token: string
          p_outcome_unknown: boolean
          p_provider: string
          p_step: string
        }
        Returns: boolean
      }
      fail_webhook_event: {
        Args: {
          p_error: string
          p_event_id: string
          p_lease_token: string
          p_provider: string
        }
        Returns: boolean
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
      finalize_communication_send: {
        Args: {
          p_claim_token: string
          p_id: string
          p_provider_id: string
          p_sent_at?: string
        }
        Returns: boolean
      }
      has_signed_contractor_agreement: { Args: never; Returns: boolean }
      heartbeat_ai_job: {
        Args: { p_job_id: string; p_lease_seconds?: number; p_worker: string }
        Returns: boolean
      }
      ignore_failed_ai_media: {
        Args: { p_actor_id: string; p_media_id: string }
        Returns: boolean
      }
      is_admin: { Args: never; Returns: boolean }
      is_office: { Args: never; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      my_email: { Args: never; Returns: string }
      next_quote_ref: { Args: { kind: string }; Returns: string }
      next_statement_ref: { Args: never; Returns: string }
      reclaim_communication_send: {
        Args: {
          p_id: string
          p_lease_seconds?: number
          p_new_claim_token: string
          p_old_claim_token: string
          p_provider_payload_hash: string
        }
        Returns: boolean
      }
      recompute_ai_room_state: {
        Args: { p_room_id: string }
        Returns: undefined
      }
      release_ai_call: { Args: { p_attempt_key: string }; Returns: boolean }
      release_stale_ai_reservations: {
        Args: { p_age_minutes?: number }
        Returns: number
      }
      report_operational_issue: {
        Args: {
          p_context?: Json
          p_event: string
          p_issue_key: string
          p_message: string
          p_severity: string
          p_source: string
        }
        Returns: string
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
      resolve_ai_duplicate_group: {
        Args: {
          p_actor_id: string
          p_choice: string
          p_detection_ids: string[]
          p_qty: number
        }
        Returns: Json
      }
      resolve_operational_issue: {
        Args: { p_issue_key: string }
        Returns: boolean
      }
      retry_ai_job: {
        Args: { p_actor_id: string; p_job_id: string }
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
      simulate_operational_issue_digest: {
        Args: { p_claim_token: string; p_snapshot_date: string }
        Returns: boolean
      }
      start_communication_provider: {
        Args: { p_claim_token: string; p_id: string }
        Returns: string
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
      appt_type: "survey" | "removal" | "pack"
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
        | "checkatrade"
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
      appt_type: ["survey", "removal", "pack"],
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
        "checkatrade",
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

