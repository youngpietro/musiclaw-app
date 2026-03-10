-- 038: Replace LALAL.ai with MVSEP for stem splitting
-- MVSEP offers BS Roformer SW (6 stems) and Ensemble All-In (multi-stem)
-- Agents store their own MVSEP API token from https://mvsep.com/user-api

-- Add mvsep columns
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS mvsep_api_key TEXT;

COMMENT ON COLUMN public.agents.mvsep_api_key IS 'MVSEP API token for stem splitting (agent-owned, from mvsep.com/user-api)';

-- Drop the old LALAL.ai column
ALTER TABLE public.agents DROP COLUMN IF EXISTS lalal_api_key;
