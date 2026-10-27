
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "categories": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"id": string,"image_path": string | null,"is_active": boolean,"name": string,"seed_key": string | null,"shop_id": string,"slug": string,"sort_order": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"id"?: string,"image_path"?: string | null,"is_active"?: boolean,"name": string,"seed_key"?: string | null,"shop_id": string,"slug": string,"sort_order"?: number,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"id"?: string,"image_path"?: string | null,"is_active"?: boolean,"name"?: string,"seed_key"?: string | null,"shop_id"?: string,"slug"?: string,"sort_order"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "categories_shop_id_fkey"
      columns: ["shop_id"]
isOneToOne: false
      referencedRelation: "shops"
      referencedColumns: ["id"]
    }
                  ]
                },"inventory_movements": {
                  Row: {
                    "actor_user_id": string | null,"created_at": string,"delta": number,"id": number,"operation_key": string,"order_id": string | null,"reason": string,"shop_id": string,"variant_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_user_id"?: string | null,"created_at"?: string,"delta": number,"id"?: never,"operation_key": string,"order_id"?: string | null,"reason": string,"shop_id": string,"variant_id": string
                  }
                  Update: {
                    "actor_user_id"?: string | null,"created_at"?: string,"delta"?: number,"id"?: never,"operation_key"?: string,"order_id"?: string | null,"reason"?: string,"shop_id"?: string,"variant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "inventory_movements_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "inventory_movements_shop_id_fkey"
      columns: ["shop_id"]
isOneToOne: false
      referencedRelation: "shops"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "inventory_movements_variant_id_fkey"
      columns: ["variant_id"]
isOneToOne: false
      referencedRelation: "product_variants"
      referencedColumns: ["id"]
    }
                  ]
                },"order_items": {
                  Row: {
                    "color": string | null,"created_at": string,"flavor": string | null,"id": string,"line_total_minor": number,"order_id": string,"product_id": string | null,"product_name": string,"quantity": number,"shop_id": string,"unit_price_minor": number,"variant_id": string | null,"variant_label": string
                  }
                  ComputedFields: never
                  Insert: {
                    "color"?: string | null,"created_at"?: string,"flavor"?: string | null,"id"?: string,"line_total_minor": number,"order_id": string,"product_id"?: string | null,"product_name": string,"quantity": number,"shop_id": string,"unit_price_minor": number,"variant_id"?: string | null,"variant_label"?: string
                  }
                  Update: {
                    "color"?: string | null,"created_at"?: string,"flavor"?: string | null,"id"?: string,"line_total_minor"?: number,"order_id"?: string,"product_id"?: string | null,"product_name"?: string,"quantity"?: number,"shop_id"?: string,"unit_price_minor"?: number,"variant_id"?: string | null,"variant_label"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "order_items_product_id_fkey"
      columns: ["product_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "order_items_shop_id_order_id_fkey"
      columns: ["shop_id","order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["shop_id","id"]
    },{
      foreignKeyName: "order_items_variant_id_fkey"
      columns: ["variant_id"]
isOneToOne: false
      referencedRelation: "product_variants"
      referencedColumns: ["id"]
    }
                  ]
                },"orders": {
                  Row: {
                    "comment": string | null,"contact_name": string | null,"contact_phone": string | null,"created_at": string,"currency": string,"customer_snapshot": NonNullable<Json>,"customer_tg_id": number,"delivery_address": string | null,"fulfillment_method": string | null,"id": string,"idempotency_key": string,"is_test": boolean,"order_number": number,"request_hash": string,"shop_id": string,"status": string,"stock_state": string,"total_minor": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "comment"?: string | null,"contact_name"?: string | null,"contact_phone"?: string | null,"created_at"?: string,"currency": string,"customer_snapshot"?: NonNullable<Json>,"customer_tg_id": number,"delivery_address"?: string | null,"fulfillment_method"?: string | null,"id"?: string,"idempotency_key": string,"is_test"?: boolean,"order_number": number,"request_hash": string,"shop_id": string,"status"?: string,"stock_state"?: string,"total_minor": number,"updated_at"?: string
                  }
                  Update: {
                    "comment"?: string | null,"contact_name"?: string | null,"contact_phone"?: string | null,"created_at"?: string,"currency"?: string,"customer_snapshot"?: NonNullable<Json>,"customer_tg_id"?: number,"delivery_address"?: string | null,"fulfillment_method"?: string | null,"id"?: string,"idempotency_key"?: string,"is_test"?: boolean,"order_number"?: number,"request_hash"?: string,"shop_id"?: string,"status"?: string,"stock_state"?: string,"total_minor"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "orders_shop_id_fkey"
      columns: ["shop_id"]
isOneToOne: false
      referencedRelation: "shops"
      referencedColumns: ["id"]
    }
                  ]
                },"platform_admins": {
                  Row: {
                    "created_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"product_images": {
                  Row: {
                    "alt_text": string,"created_at": string,"id": string,"is_primary": boolean,"product_id": string,"seed_key": string | null,"shop_id": string,"sort_order": number,"storage_path": string
                  }
                  ComputedFields: never
                  Insert: {
                    "alt_text"?: string,"created_at"?: string,"id"?: string,"is_primary"?: boolean,"product_id": string,"seed_key"?: string | null,"shop_id": string,"sort_order"?: number,"storage_path": string
                  }
                  Update: {
                    "alt_text"?: string,"created_at"?: string,"id"?: string,"is_primary"?: boolean,"product_id"?: string,"seed_key"?: string | null,"shop_id"?: string,"sort_order"?: number,"storage_path"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "product_images_shop_id_fkey"
      columns: ["shop_id"]
isOneToOne: false
      referencedRelation: "shops"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "product_images_shop_id_product_id_fkey"
      columns: ["shop_id","product_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["shop_id","id"]
    }
                  ]
                },"product_variants": {
                  Row: {
                    "color": string | null,"created_at": string,"flavor": string | null,"id": string,"is_active": boolean,"price_override_minor": number | null,"product_id": string,"seed_key": string | null,"shop_id": string,"sku": string | null,"sort_order": number,"stock_quantity": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "color"?: string | null,"created_at"?: string,"flavor"?: string | null,"id"?: string,"is_active"?: boolean,"price_override_minor"?: number | null,"product_id": string,"seed_key"?: string | null,"shop_id": string,"sku"?: string | null,"sort_order"?: number,"stock_quantity"?: number,"updated_at"?: string
                  }
                  Update: {
                    "color"?: string | null,"created_at"?: string,"flavor"?: string | null,"id"?: string,"is_active"?: boolean,"price_override_minor"?: number | null,"product_id"?: string,"seed_key"?: string | null,"shop_id"?: string,"sku"?: string | null,"sort_order"?: number,"stock_quantity"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "product_variants_shop_id_fkey"
      columns: ["shop_id"]
isOneToOne: false
      referencedRelation: "shops"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "product_variants_shop_id_product_id_fkey"
      columns: ["shop_id","product_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["shop_id","id"]
    }
                  ]
                },"products": {
                  Row: {
                    "archived_at": string | null,"base_price_minor": number,"category_id": string,"created_at": string,"description": string,"id": string,"is_featured": boolean,"is_published": boolean,"name": string,"seed_key": string | null,"shop_id": string,"sort_order": number,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"base_price_minor": number,"category_id": string,"created_at"?: string,"description"?: string,"id"?: string,"is_featured"?: boolean,"is_published"?: boolean,"name": string,"seed_key"?: string | null,"shop_id": string,"sort_order"?: number,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"base_price_minor"?: number,"category_id"?: string,"created_at"?: string,"description"?: string,"id"?: string,"is_featured"?: boolean,"is_published"?: boolean,"name"?: string,"seed_key"?: string | null,"shop_id"?: string,"sort_order"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "products_shop_id_category_id_fkey"
      columns: ["shop_id","category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["shop_id","id"]
    },{
      foreignKeyName: "products_shop_id_fkey"
      columns: ["shop_id"]
isOneToOne: false
      referencedRelation: "shops"
      referencedColumns: ["id"]
    }
                  ]
                },"shop_memberships": {
                  Row: {
                    "created_at": string,"id": string,"role": string,"shop_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"role"?: string,"shop_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"role"?: string,"shop_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "shop_memberships_shop_id_fkey"
      columns: ["shop_id"]
isOneToOne: false
      referencedRelation: "shops"
      referencedColumns: ["id"]
    }
                  ]
                },"shop_order_counters": {
                  Row: {
                    "last_number": number,"shop_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "last_number"?: number,"shop_id": string
                  }
                  Update: {
                    "last_number"?: number,"shop_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "shop_order_counters_shop_id_fkey"
      columns: ["shop_id"]
isOneToOne: true
      referencedRelation: "shops"
      referencedColumns: ["id"]
    }
                  ]
                },"shops": {
                  Row: {
                    "age_restriction": number,"cover_path": string | null,"created_at": string,"currency": string,"delivery_enabled": boolean,"description": string,"id": string,"info": NonNullable<Json>,"is_demo": boolean,"legal_notice": string,"logo_path": string | null,"mode": string,"name": string,"pickup_enabled": boolean,"pickup_instructions": string,"published_at": string | null,"settings": NonNullable<Json>,"slug": string,"status": string,"telegram": NonNullable<Json>,"theme_config": NonNullable<Json>,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "age_restriction"?: number,"cover_path"?: string | null,"created_at"?: string,"currency": string,"delivery_enabled"?: boolean,"description"?: string,"id"?: string,"info"?: NonNullable<Json>,"is_demo"?: boolean,"legal_notice"?: string,"logo_path"?: string | null,"mode"?: string,"name": string,"pickup_enabled"?: boolean,"pickup_instructions"?: string,"published_at"?: string | null,"settings"?: NonNullable<Json>,"slug": string,"status"?: string,"telegram"?: NonNullable<Json>,"theme_config": NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "age_restriction"?: number,"cover_path"?: string | null,"created_at"?: string,"currency"?: string,"delivery_enabled"?: boolean,"description"?: string,"id"?: string,"info"?: NonNullable<Json>,"is_demo"?: boolean,"legal_notice"?: string,"logo_path"?: string | null,"mode"?: string,"name"?: string,"pickup_enabled"?: boolean,"pickup_instructions"?: string,"published_at"?: string | null,"settings"?: NonNullable<Json>,"slug"?: string,"status"?: string,"telegram"?: NonNullable<Json>,"theme_config"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "admin_set_order_status":
{ Args: { "p_order_id": string,"p_status": string }; Returns: Json
                           },
"admin_set_variant_stock":
{ Args: { "p_quantity": number,"p_variant_id": string }; Returns: Json
                           },
"create_order":
{ Args: { "p_comment": string,"p_customer_snapshot": Json,"p_customer_tg_id": number,"p_delivery_address": string,"p_expected_currency": string,"p_expected_total_minor": number,"p_fulfillment_method": string,"p_idempotency_key": string,"p_items": Json,"p_request_hash": string,"p_shop_slug": string }; Returns: Json
                           },
"get_customer_orders":
{ Args: { "p_customer_tg_id": number,"p_limit"?: number,"p_order_id"?: string,"p_shop_slug": string }; Returns: Json
                           },
"is_platform_admin":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"is_shop_member":
{ Args: { "p_shop_id": string }; Returns: boolean
                           },
"is_supported_currency":
{ Args: { "p_code": string }; Returns: boolean
                           },
"is_valid_theme":
{ Args: { "p": Json }; Returns: boolean
                           },
"notify_claim":
{ Args: { "p_limit": number,"p_order_id": string,"p_shop_id": string }; Returns: Json
                           },
"notify_complete":
{ Args: { "p_error": string,"p_message_id": number,"p_notification_id": number,"p_ok": boolean }; Returns: undefined
                           },
"notify_delete_settings":
{ Args: { "p_actor": string,"p_shop_id": string }; Returns: Json
                           },
"notify_get_credentials":
{ Args: { "p_actor": string,"p_shop_id": string }; Returns: Json
                           },
"notify_get_settings":
{ Args: { "p_actor": string,"p_shop_id": string }; Returns: Json
                           },
"notify_record_check":
{ Args: { "p_actor": string,"p_error": string,"p_ok": boolean,"p_shop_id": string }; Returns: Json
                           },
"notify_requeue_failed":
{ Args: { "p_actor": string,"p_shop_id": string }; Returns: number
                           },
"notify_save_settings":
{ Args: { "p_actor": string,"p_bot_token": string,"p_chat_id": string,"p_meta": Json,"p_shop_id": string }; Returns: Json
                           },
"notify_set_enabled":
{ Args: { "p_actor": string,"p_enabled": boolean,"p_shop_id": string }; Returns: Json
                           },
"order_status_transition_allowed":
{ Args: { "p_from": string,"p_to": string }; Returns: boolean
                           },
"order_to_json":
{ Args: { "p_order_id": string }; Returns: Json
                           },
"platform_create_demo_shop":
{ Args: { "p_actor": string,"p_name": string,"p_slug": string,"p_template_id": string }; Returns: Json
                           },
"platform_discard_demo_shop":
{ Args: { "p_actor": string,"p_shop_id": string }; Returns: boolean
                           },
"platform_find_user":
{ Args: { "p_actor": string,"p_email": string }; Returns: Json
                           },
"platform_handover_check":
{ Args: { "p_actor": string,"p_shop_id": string }; Returns: Json
                           },
"platform_handover_shop":
{ Args: { "p_actor": string,"p_invitation": string,"p_new_owner": string,"p_shop_id": string }; Returns: Json
                           },
"platform_list_shops":
{ Args: { "p_actor": string }; Returns: Json
                           },
"platform_publish_demo_shop":
{ Args: { "p_actor": string,"p_shop_id": string }; Returns: Json
                           },
"platform_transfer_shop":
{ Args: { "p_actor": string,"p_new_owner": string,"p_shop_id": string }; Returns: Json
                           },
"product_is_public":
{ Args: { "p_product_id": string }; Returns: boolean
                           },
"shop_is_public":
{ Args: { "p_shop_id": string }; Returns: boolean
                           },
"storage_object_shop_id":
{ Args: { "p_name": string }; Returns: string
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
