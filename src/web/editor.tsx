import type { PageCtx } from './ctx.ts';
import { COLORS } from '../lib/bbcode.ts';

/**
 * BBCode editor. Works as a plain textarea without JavaScript; the client script adds the
 * toolbar actions, emoji picker, live preview, image upload and draft autosave.
 */
export function Editor({ ctx, name = 'body', value = '', label = 'Message', draftKey, uploadPurpose = 'post', allowImages = true, rows = 12, id = 'editor', maxlength = 30000, required = true, error }: {
  ctx: PageCtx; name?: string; value?: string; label?: string; draftKey?: string; uploadPurpose?: 'post' | 'message' | null; allowImages?: boolean; rows?: number; id?: string; maxlength?: number; required?: boolean; error?: string;
}) {
  const B = ({ tag, label, title, arg }: { tag: string; label: string; title: string; arg?: string }) =>
    <button type="button" class="ed-btn" data-bb={tag} data-bb-arg={arg} title={title} aria-label={label.length <= 1 ? title : undefined}>{label}</button>;
  return (
    <div class={`editor ${error ? 'has-error' : ''}`} data-editor data-draft-key={draftKey} data-upload-purpose={allowImages && uploadPurpose ? uploadPurpose : ''}>
      <label for={id} class="editor-label">{label}</label>
      <div class="ed-toolbar" role="toolbar" aria-label="Formatting" aria-controls={id}>
        <B tag="b" label="B" title="Bold" />
        <B tag="i" label="I" title="Italic" />
        <B tag="u" label="U" title="Underline" />
        <B tag="s" label="S" title="Strikethrough" />
        <span class="ed-sep" />
        <B tag="url" label="Link" title="Insert link" />
        <B tag="quote" label="Quote" title="Quote" />
        <B tag="code" label="Code" title="Code block" />
        <B tag="list" label="List" title="Bulleted list" />
        <B tag="spoiler" label="Spoiler" title="Spoiler (hidden until clicked)" />
        <B tag="media" label="Video" title="Embed a YouTube or Vimeo link" />
        <select class="ed-color" data-bb-color aria-label="Text colour">
          <option value="">Colour</option>
          {COLORS.map((c) => <option value={c}>{c}</option>)}
        </select>
        <span class="ed-sep" />
        <button type="button" class="ed-btn" data-emoji-toggle aria-haspopup="dialog" aria-expanded="false" title="Insert emoji" aria-label="Insert emoji">☺ Emoji</button>
        {allowImages && uploadPurpose ? <label class="ed-btn ed-upload" title="Attach image (PNG, JPEG, WebP, GIF)"><span class="ico ico-image" aria-hidden="true"></span> Image<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-upload-input class="sr-only" /></label> : null}
        <button type="button" class="ed-btn ed-preview-btn" data-preview-toggle aria-pressed="false">Preview</button>
      </div>
      <textarea id={id} name={name} rows={rows} maxlength={maxlength} required={required} class="ed-text" data-ed-text aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-err` : `${id}-help`}>{value}</textarea>
      <div class="ed-preview bb" data-ed-preview hidden aria-live="polite"></div>
      <div class="ed-uploads" data-ed-uploads></div>
      {error ? <div class="field-error" id={`${id}-err`}>{error}</div> : null}
      <div class="field-hint" id={`${id}-help`}>
        BBCode: [b], [i], [u], [s], [url], [quote], [code], [list][*], [spoiler], [color=red]. Paste a YouTube link on its own line to embed it.
        Videos and files can't be uploaded — share a link instead. <span data-draft-status class="muted"></span>
      </div>
      <input type="hidden" name="_csrf_editor" value={ctx.csrf} disabled />
    </div>
  );
}
