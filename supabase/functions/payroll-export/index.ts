import { createHandler } from "./handler.ts";
import { supabaseDeps } from "./deps.ts";

Deno.serve(createHandler(supabaseDeps));
