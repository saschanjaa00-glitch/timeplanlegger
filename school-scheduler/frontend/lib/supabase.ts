import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type CloudSavefile = {
  id: string;
  user_id: string;
  name: string;
  data: string; // JSON string of PersistedState
  created_at: string;
  updated_at: string;
};
