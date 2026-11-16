-- Direct messages are append-only for ordinary users (core product rule).
-- Content columns can never change and rows can never be deleted through SQL.
-- Only the hidden_* moderation columns may be set, via the audited staff process.
CREATE OR REPLACE FUNCTION direct_messages_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'direct_messages is append-only: DELETE is not permitted';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.client_nonce IS DISTINCT FROM OLD.client_nonce
     OR NEW.links IS DISTINCT FROM OLD.links THEN
    RAISE EXCEPTION 'direct_messages is append-only: message content cannot be modified';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER direct_messages_append_only_trg
  BEFORE UPDATE OR DELETE ON direct_messages
  FOR EACH ROW EXECUTE FUNCTION direct_messages_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION message_attachments_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'message_attachments is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER message_attachments_append_only_trg
  BEFORE UPDATE OR DELETE ON message_attachments
  FOR EACH ROW EXECUTE FUNCTION message_attachments_append_only();
