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
      vehicles: {
        Row: {
          id: string
          name: string
          vehicle_type: string
          registration: string
          tax_due: string | null
          mot_due: string | null
          insurance_renewal: string | null
          last_service: string | null
          cost_per_month: number | null
          payment_day: number | null
          end_of_term: string | null
          notes: string | null
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          vehicle_type?: string
          registration?: string
          tax_due?: string | null
          mot_due?: string | null
          insurance_renewal?: string | null
          last_service?: string | null
          cost_per_month?: number | null
          payment_day?: number | null
          end_of_term?: string | null
          notes?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          vehicle_type?: string
          registration?: string
          tax_due?: string | null
          mot_due?: string | null
          insurance_renewal?: string | null
          last_service?: string | null
          cost_per_month?: number | null
          payment_day?: number | null
          end_of_term?: string | null
          notes?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      staff: {
        Row: {
          id: string
          profile_id: string | null
          full_name: string
          staff_role: string
          phone: string | null
          email: string | null
          day_rate: number | null
          notes: string | null
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          profile_id?: string | null
          full_name: string
          staff_role?: string
          phone?: string | null
          email?: string | null
          day_rate?: number | null
          notes?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          profile_id?: string | null
          full_name?: string
          staff_role?: string
          phone?: string | null
          email?: string | null
          day_rate?: number | null
          notes?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      appointment_assignments: {
        Row: {
          id: string
          appointment_id: string
          staff_id: string | null
          vehicle_id: string | null
          created_at: string
        }
        Insert: {
          id?: string
          appointment_id: string
          staff_id?: string | null
          vehicle_id?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          appointment_id?: string
          staff_id?: string | null
          vehicle_id?: string | null
          created_at?: string
        }
        Relationships: []
      }
      storage_sites: {
        Row: {
          id: string
          name: string
          address: string
          notes: string | null
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          address?: string
          notes?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          address?: string
          notes?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      storage_units: {
        Row: {
          id: string
          site_id: string
          code: string
          name: string
          unit_type: string
          size_cuft: number | null
          notes: string | null
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          site_id: string
          code?: string
          name?: string
          unit_type?: string
          size_cuft?: number | null
          notes?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          site_id?: string
          code?: string
          name?: string
          unit_type?: string
          size_cuft?: number | null
          notes?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      storage_lets: {
        Row: {
          id: string
          unit_id: string
          client_id: string
          lead_id: string | null
          start_date: string
          end_date: string | null
          rate: number | null
          rate_period: string
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          unit_id: string
          client_id: string
          lead_id?: string | null
          start_date: string
          end_date?: string | null
          rate?: number | null
          rate_period?: string
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          unit_id?: string
          client_id?: string
          lead_id?: string | null
          start_date?: string
          end_date?: string | null
          rate?: number | null
          rate_period?: string
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
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
          base_location: string
          cost_75t: number
          cost_box: number
          cost_fuel_75_per_mile: number
          cost_fuel_per_mile: number
          cost_labour_per_day: number
          cost_misc: number
          cost_transit_day: number
          cost_van_day: number
          default_deposit: number
          estimator_fee: number
          google_review_url: string
          id: boolean
          pricing: Json | null
          updated_at: string
          vat_default: boolean
        }
        Insert: {
          base_location?: string
          cost_75t?: number
          cost_box?: number
          cost_fuel_75_per_mile?: number
          cost_fuel_per_mile?: number
          cost_labour_per_day?: number
          cost_misc?: number
          cost_transit_day?: number
          cost_van_day?: number
          default_deposit?: number
          estimator_fee?: number
          google_review_url?: string
          id?: boolean
          pricing?: Json | null
          updated_at?: string
          vat_default?: boolean
        }
        Update: {
          base_location?: string
          cost_75t?: number
          cost_box?: number
          cost_fuel_75_per_mile?: number
          cost_fuel_per_mile?: number
          cost_labour_per_day?: number
          cost_misc?: number
          cost_transit_day?: number
          cost_van_day?: number
          default_deposit?: number
          estimator_fee?: number
          google_review_url?: string
          id?: boolean
          pricing?: Json | null
          updated_at?: string
          vat_default?: boolean
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
      leads: {
        Row: {
          balance_amount: number | null
          balance_due_date: string | null
          balance_paid_at: string | null
          campaign: string | null
          client_id: string
          created_at: string
          deposit_amount: number | null
          deposit_paid_at: string | null
          deposit_requested_at: string | null
          chase_paused: boolean
          deposit_chase_at: string | null
          deposit_chase_step: number
          lost_at: string | null
          lost_note: string | null
          lost_reason: string | null
          review_requested_at: string | null
          quote_chase_at: string | null
          quote_chase_step: number
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
          msclkid: string | null
          name: string | null
          notes: string | null
          phone: string | null
          posthog_distinct_id: string | null
          preferred_date: string | null
          property_size: string | null
          referrer_answer: string | null
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
          client_id: string
          created_at?: string
          deposit_amount?: number | null
          deposit_paid_at?: string | null
          deposit_requested_at?: string | null
          chase_paused?: boolean
          deposit_chase_at?: string | null
          deposit_chase_step?: number
          lost_at?: string | null
          lost_note?: string | null
          lost_reason?: string | null
          review_requested_at?: string | null
          quote_chase_at?: string | null
          quote_chase_step?: number
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
          msclkid?: string | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          posthog_distinct_id?: string | null
          preferred_date?: string | null
          property_size?: string | null
          referrer_answer?: string | null
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
          client_id?: string
          created_at?: string
          deposit_amount?: number | null
          deposit_paid_at?: string | null
          deposit_requested_at?: string | null
          chase_paused?: boolean
          deposit_chase_at?: string | null
          deposit_chase_step?: number
          lost_at?: string | null
          lost_note?: string | null
          lost_reason?: string | null
          review_requested_at?: string | null
          quote_chase_at?: string | null
          quote_chase_step?: number
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
          msclkid?: string | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          posthog_distinct_id?: string | null
          preferred_date?: string | null
          property_size?: string | null
          referrer_answer?: string | null
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
          deposit_amount: number | null
          deposit_paid_at: string | null
          deposit_paid_method: string | null
          deposit_selfreport_at: string | null
          declined_at: string | null
          declined_reason: string | null
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
          deposit_amount?: number | null
          deposit_paid_at?: string | null
          deposit_paid_method?: string | null
          deposit_selfreport_at?: string | null
          declined_at?: string | null
          declined_reason?: string | null
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
          deposit_amount?: number | null
          deposit_paid_at?: string | null
          deposit_paid_method?: string | null
          deposit_selfreport_at?: string | null
          declined_at?: string | null
          declined_reason?: string | null
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_admin: { Args: never; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
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
      photo_category: "access" | "large_items"
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
      photo_category: ["access", "large_items"],
      quote_status: ["draft", "sent", "accepted", "rejected", "superseded"],
      survey_status: ["scheduled", "completed", "cancelled"],
      user_role: ["admin", "estimator", "crew"],
    },
  },
} as const

