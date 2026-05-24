-- Auto-sync triggers table from flows.nodes JSON.
--
-- Why: ZernFlow's flow editor saves flows directly via Supabase client
-- (bypassing the Next.js API), so server-side sync logic in PUT/publish
-- routes only fires when explicitly published. This DB trigger guarantees
-- that any change to flows.nodes or flows.status — regardless of caller —
-- rebuilds the triggers table accordingly.

CREATE OR REPLACE FUNCTION sync_triggers_from_flow_nodes()
RETURNS TRIGGER AS $$
DECLARE
  node jsonb;
  trigger_type text;
  trigger_config jsonb;
  channel_uuid uuid;
BEGIN
  -- Wipe existing triggers for this flow (clean slate).
  DELETE FROM triggers WHERE flow_id = NEW.id;

  -- Bail if nodes is not a JSON array.
  IF NEW.nodes IS NULL OR jsonb_typeof(NEW.nodes) <> 'array' THEN
    RETURN NEW;
  END IF;

  FOR node IN SELECT * FROM jsonb_array_elements(NEW.nodes)
  LOOP
    IF node->>'type' = 'trigger' THEN
      trigger_type := COALESCE(node->'data'->>'triggerType', 'keyword');

      -- Skip unknown trigger types (defensive).
      IF trigger_type NOT IN (
        'keyword', 'comment_keyword', 'postback',
        'quick_reply', 'welcome', 'default'
      ) THEN
        CONTINUE;
      END IF;

      -- Build per-type config.
      trigger_config := '{}'::jsonb;

      IF trigger_type IN ('keyword', 'comment_keyword')
         AND node->'data'->'keywords' IS NOT NULL THEN
        trigger_config := trigger_config
          || jsonb_build_object('keywords', node->'data'->'keywords');
      END IF;

      IF trigger_type = 'comment_keyword' THEN
        IF node->'data'->'postIds' IS NOT NULL
           AND jsonb_typeof(node->'data'->'postIds') = 'array'
           AND jsonb_array_length(node->'data'->'postIds') > 0 THEN
          trigger_config := trigger_config
            || jsonb_build_object('postIds', node->'data'->'postIds');
        END IF;
        IF node->'data'->>'replyText' IS NOT NULL
           AND length(node->'data'->>'replyText') > 0 THEN
          trigger_config := trigger_config
            || jsonb_build_object('replyText', node->'data'->>'replyText');
        END IF;
      END IF;

      IF trigger_type IN ('postback', 'quick_reply')
         AND node->'data'->>'payload' IS NOT NULL THEN
        trigger_config := trigger_config
          || jsonb_build_object('payload', node->'data'->>'payload');
      END IF;

      -- Parse channelId; null on missing / invalid UUID.
      channel_uuid := NULL;
      BEGIN
        IF node->'data'->>'channelId' IS NOT NULL
           AND length(node->'data'->>'channelId') > 0 THEN
          channel_uuid := (node->'data'->>'channelId')::uuid;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        channel_uuid := NULL;
      END;

      INSERT INTO triggers (flow_id, channel_id, type, config, is_active, priority)
      VALUES (
        NEW.id,
        channel_uuid,
        trigger_type,
        trigger_config,
        NEW.status = 'published',
        COALESCE((node->'data'->>'priority')::int, 0)
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_sync_triggers_on_flow_change ON flows;
CREATE TRIGGER trg_sync_triggers_on_flow_change
AFTER INSERT OR UPDATE OF nodes, status ON flows
FOR EACH ROW
EXECUTE FUNCTION sync_triggers_from_flow_nodes();
