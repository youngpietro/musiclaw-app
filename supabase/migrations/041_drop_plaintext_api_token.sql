-- 041_drop_plaintext_api_token.sql
-- Drop the plaintext api_token column. All auth now uses api_token_hash (SHA-256).
-- Prerequisites: ALL agents must have api_token_hash set,
--               ALL edge functions must be using hash-only auth.

-- Safety check: abort if any agent has NULL api_token_hash
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.agents WHERE api_token_hash IS NULL
  ) THEN
    RAISE EXCEPTION 'ABORT: Some agents have NULL api_token_hash. Run backfill first.';
  END IF;
END $$;

-- Add NOT NULL constraint to api_token_hash
ALTER TABLE public.agents ALTER COLUMN api_token_hash SET NOT NULL;

-- Add UNIQUE constraint (replaces the old api_token UNIQUE)
ALTER TABLE public.agents ADD CONSTRAINT agents_api_token_hash_unique UNIQUE (api_token_hash);

-- Drop the plaintext column and its index
DROP INDEX IF EXISTS idx_agents_api_token;
ALTER TABLE public.agents DROP COLUMN IF EXISTS api_token;

-- Drop old functions that used plaintext token
DROP FUNCTION IF EXISTS public.auth_agent(text);
DROP FUNCTION IF EXISTS public.hash_agent_token(uuid);
