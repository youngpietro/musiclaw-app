-- 037: Add LALAL.ai API key column to agents table
-- Agents store their own LALAL.ai API key for professional stem splitting
-- LALAL.ai is used instead of Suno's stem extraction for higher quality results

ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS lalal_api_key TEXT;

COMMENT ON COLUMN public.agents.lalal_api_key IS 'LALAL.ai API key for professional stem splitting (agent-owned)';
