-- Members may erase direct messages they sent (Your data › Delete your data). Messages stay append-only for
-- everything else: only a transaction that has switched on erasure mode with
--   select set_config('fragged.erasure', 'on', true)
-- may blank a message's text and links (nothing else), or remove its attachments. The erasure service does this
-- inside an audited transaction and skips conversations with an open report.
CREATE OR REPLACE FUNCTION direct_messages_append_only() RETURNS trigger AS $$
DECLARE
  erasing boolean := coalesce(current_setting('fragged.erasure', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'direct_messages is append-only: DELETE is not permitted';
  END IF;
  IF NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.client_nonce IS DISTINCT FROM OLD.client_nonce THEN
    RAISE EXCEPTION 'direct_messages is append-only: message content cannot be modified';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.links IS DISTINCT FROM OLD.links THEN
    IF NOT (erasing AND NEW.body = '' AND NEW.links = '[]'::jsonb) THEN
      RAISE EXCEPTION 'direct_messages is append-only: message content cannot be modified';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION message_attachments_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('fragged.erasure', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'message_attachments is append-only';
END;
$$ LANGUAGE plpgsql;
