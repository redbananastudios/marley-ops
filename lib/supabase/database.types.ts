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
          cost_box: number
          cost_fuel_per_mile: number
          cost_labour_per_hour: number
          cost_van_day: number
          estimator_fee: number
          id: boolean
          updated_at: string
        }
        Insert: {
          cost_box?: number
          cost_fuel_per_mile?: number
          cost_labour_per_hour?: number
          cost_van_day?: number
          estimator_fee?: number
          id?: boolean
          updated_at?: string
        }
        Update: {
          cost_box?: number
          cost_fuel_per_mile?: number
          cost_labour_per_hour?: number
          cost_van_day?: number
          estimator_fee?: number
          id?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      clients: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          email_norm: string | null
          id: string
          is_active: boolean
          merged_into_id: string | null
          notes: string | null
          phone_e164: string | null
          phone_raw: string | null
          postcode_home: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          email_norm?: string | null
          id?: string
          is_active?: boolean
          merged_into_id?: string | null
          notes?: string | null
          phone_e164?: string | null
          phone_raw?: string | null
          postcode_home?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          email_norm?: string | null
          id?: string
          is_active?: boolean
          merged_into_id?: string | null
          notes?: string | null
          phone_e164?: string | null
          phone_raw?: string | null
          postcode_home?: string | null
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
      leads: {
        Row: {
          campaign: string | null
          client_id: string
          created_at: string
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
          campaign?: string | null
          client_id: string
          created_at?: string
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
          campaign?: string | null
          client_id?: string
          created_at?: string
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
          accepted_at: string | null
          agreed_price: number | null
          breakdown: Json
          client_id: string | null
          collect_addr: string | null
          created_at: string
          customer_email: string | null
          customer_name: string | null
          customer_phone: string | null
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
        }
        Insert: {
          accepted_at?: string | null
          agreed_price?: number | null
          breakdown?: Json
          client_id?: string | null
          collect_addr?: string | null
          created_at?: string
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
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
        }
        Update: {
          accepted_at?: string | null
          agreed_price?: number | null
          breakdown?: Json
          client_id?: string | null
          collect_addr?: string | null
          created_at?: string
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
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
      user_role: "admin" | "estimator"
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
      user_role: ["admin", "estimator"],
    },
  },
} as const

