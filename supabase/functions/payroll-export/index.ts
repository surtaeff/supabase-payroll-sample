import { createHandler } from "./handler.ts";
import { supabaseDeps } from "./deps.ts";

// Set with: supabase secrets set ALLOWED_ORIGIN=https://office.example.com
Deno.serve(createHandler(supabaseDeps, { allowedOrigin: Deno.env.get("ALLOWED_ORIGIN") ?? "" }));
