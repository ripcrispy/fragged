/** Admin › Modules: inspect, enable/disable and configure installed modules. */
import { Hono } from 'hono';
import type { Env, C } from '../web/ctx.ts';
import { form, str, bool, setFlash } from '../web/ctx.ts';
import { Box, Csrf, Notice, ActionButton } from '../web/components.tsx';
import { adminShell } from './admin.tsx';
import {
  listModules, isModuleEnabled, setModuleEnabled, moduleSettings, saveModuleSettings, dependents, ModuleStateError, moduleOrder,
} from '../modules/runtime.ts';
import { registries, hookHandlers } from '../modules/registry.ts';
import { SDK_VERSION } from '../sdk/version.ts';
import { audit } from '../services/audit.ts';
import type { SettingField } from '../sdk/types.ts';

export const moduleAdminRoutes = new Hono<Env>();

async function guard(c: C) { const v = c.get('viewer'); await v.require('admin.access'); await v.require('admin.modules'); return v; }

/** What a module contributes, from the live registries. */
function contributions(id: string): string[] {
  const out: string[] = [];
  const count = (name: string, n: number) => { if (n) out.push(`${n} ${name}${n === 1 ? '' : 's'}`); };
  const of = (r: { entries(): { owner: string }[] }) => r.entries().filter((e) => e.owner === id).length;
  count('theme', of(registries.themes)); count('sign-in provider', of(registries.authProviders)); count('media provider', of(registries.mediaProviders));
  count('profile section', of(registries.profileSections) + of(registries.profileSettings)); count('link', of(registries.navItems));
  count('admin page', of(registries.adminSections)); count('moderation queue', of(registries.modQueues)); count('member admin panel', of(registries.adminUserPanels)); count('thread panel', of(registries.threadPanels));
  count('hook handler', hookHandlers().filter((h) => h.owner === id).length);
  return out;
}

function SettingInput({ f, value }: { f: SettingField; value: unknown }) {
  const id = `ms-${f.key}`;
  if (f.type === 'boolean') return <div class="field field-check"><label><input type="checkbox" name={f.key} value="1" checked={!!value} /> {f.label}</label>{f.hint ? <div class="field-hint">{f.hint}</div> : null}</div>;
  if (f.type === 'env') return <div class="field"><span class="field-label"><strong>{f.label}</strong></span><span>{process.env[f.env] ? <span class="tag tag-ok">set</span> : <span class="tag tag-held">not set</span>} <code class="small">{f.env}</code></span>{f.hint ? <div class="field-hint">{f.hint}</div> : null}</div>;
  let control;
  if (f.type === 'select') control = <select id={id} name={f.key}>{f.options.map(([v, l]) => <option value={v} selected={String(value) === v}>{l}</option>)}</select>;
  else if (f.type === 'text') control = <textarea id={id} name={f.key} rows={4} maxlength={f.maxLength}>{String(value ?? '')}</textarea>;
  else if (f.type === 'number') control = <input id={id} name={f.key} type="number" value={String(value ?? '')} min={f.min} max={f.max} />;
  else control = <input id={id} name={f.key} type={f.type === 'url' ? 'url' : 'text'} value={String(value ?? '')} maxlength={f.maxLength} />;
  return <div class="field"><label for={id}>{f.label}</label>{control}{f.hint ? <div class="field-hint">{f.hint}</div> : null}</div>;
}

moduleAdminRoutes.get('/admin/modules', async (c) => {
  await guard(c);
  const ctx = c.get('page');
  const mods = [...listModules()].sort((a, b) => a.def.name.localeCompare(b.def.name));
  const settings = new Map<string, Record<string, unknown>>();
  for (const m of mods) if (m.available && m.def.settings) settings.set(m.def.id, await moduleSettings(m.def.id));
  const nameOf = (id: string) => listModules().find((m) => m.def.id === id)?.def.name ?? id;
  return adminShell(c, 'Modules', 'admin.modules', (
    <>
      <p>Modules add or replace features without changing the core. They run inside the application with full access, so only install modules you trust. Changes apply immediately on every server instance.</p>
      <p class="muted small">Module SDK {SDK_VERSION} · {mods.length} installed · {mods.filter((m) => isModuleEnabled(m.def.id)).length} enabled · load order: {moduleOrder().join(' → ') || '—'}</p>
      {mods.map((m) => {
        const d = m.def;
        const on = isModuleEnabled(d.id);
        const deps = Object.entries(d.dependencies ?? {});
        const opt = Object.entries(d.optionalDependencies ?? {});
        const usedBy = listModules().filter((o) => Object.keys(o.def.dependencies ?? {}).includes(d.id)).map((o) => o.def.id);
        const contrib = m.available ? contributions(d.id) : [];
        const perms = Object.entries(d.permissions ?? {});
        return (
          <section class={`box module-card ${on ? 'is-on' : 'is-off'}`} id={`module-${d.id}`} aria-labelledby={`mh-${d.id}`}>
            <div class="box-head">
              <h2 class="box-title" id={`mh-${d.id}`}>{d.name} <span class="small">v{d.version}</span></h2>
              <div class="box-actions">
                <span class={`tag ${!m.available ? 'tag-deleted' : on ? 'tag-ok' : 'tag-held'}`}>{!m.available ? 'Unavailable' : on ? 'Enabled' : 'Disabled'}</span>
                {m.available ? <ActionButton ctx={ctx} action={`/admin/modules/${d.id}/${on ? 'disable' : 'enable'}`} label={on ? 'Disable' : 'Enable'} className={`btn btn-small ${on ? '' : 'btn-primary'}`}
                  confirm={on ? `Disable ${d.name}? Its pages, links and features disappear immediately; its data is kept.` : undefined} /> : null}
              </div>
            </div>
            <div class="box-body">
              <p>{d.description}</p>
              {!m.available ? <Notice type="error">{m.problem}</Notice> : null}
              <dl class="kv module-meta">
                <dt>ID</dt><dd><code>{d.id}</code> · {m.source === 'package' ? 'npm package' : 'bundled'}{d.license ? ` · ${d.license}` : ''}{d.author ? ` · ${d.author}` : ''}</dd>
                <dt>Needs SDK</dt><dd><code>{d.sdk}</code></dd>
                {deps.length ? <><dt>Requires</dt><dd>{deps.map(([id, r]) => <span class={`chip ${isModuleEnabled(id) ? '' : 'chip-missing'}`}>{nameOf(id)} <code class="small">{r}</code></span>)}</dd></> : null}
                {opt.length ? <><dt>Works with</dt><dd>{opt.map(([id, r]) => <span class="chip">{nameOf(id)} <code class="small">{r}</code> {isModuleEnabled(id) ? '' : '(not enabled)'}</span>)}</dd></> : null}
                {usedBy.length ? <><dt>Required by</dt><dd>{usedBy.map((id) => <span class="chip">{nameOf(id)}</span>)}</dd></> : null}
                {d.conflicts?.length ? <><dt>Conflicts with</dt><dd>{d.conflicts.map((id) => <span class="chip">{nameOf(id)}</span>)}</dd></> : null}
                {contrib.length ? <><dt>Adds</dt><dd>{contrib.join(' · ')}</dd></> : null}
                {perms.length ? <><dt>Permissions</dt><dd>{perms.map(([k, p]) => <div><code class="small">{d.id}.{k}</code> — {p.label}</div>)}<a href="/admin/groups" class="small">Assign in Groups & permissions</a></dd></> : null}
              </dl>
              {d.settings && m.available ? (
                <details class="module-settings" open={c.req.query('open') === d.id}>
                  <summary>Settings</summary>
                  <form method="post" action={`/admin/modules/${d.id}/settings`} class="form-grid"><Csrf ctx={ctx} />
                    {d.settings.fields.map((f) => <SettingInput f={f} value={settings.get(d.id)?.[f.key]} />)}
                    <div class="form-actions"><button class="btn btn-primary btn-small">Save settings</button></div>
                  </form>
                </details>
              ) : null}
            </div>
          </section>
        );
      })}
    </>
  ));
});

async function toggle(c: C, enabled: boolean) {
  const v = await guard(c);
  const id = c.req.param('id')!;
  try {
    await setModuleEnabled(id, enabled);
    await audit(v.user!.id, enabled ? 'module.enable' : 'module.disable', { type: 'module' }, { module: id }, v.ip);
    setFlash(c, { type: 'ok', text: `${enabled ? 'Enabled' : 'Disabled'} ${id}.${!enabled && dependents(id).length ? '' : ''}` });
  } catch (e) {
    if (e instanceof ModuleStateError) setFlash(c, { type: 'error', text: e.message }); else throw e;
  }
  return c.redirect(`/admin/modules#module-${id}`);
}
moduleAdminRoutes.post('/admin/modules/:id/enable', (c) => toggle(c, true));
moduleAdminRoutes.post('/admin/modules/:id/disable', (c) => toggle(c, false));

moduleAdminRoutes.post('/admin/modules/:id/settings', async (c) => {
  const v = await guard(c);
  const id = c.req.param('id');
  const m = listModules().find((x) => x.def.id === id);
  if (!m?.def.settings) return c.notFound();
  const b = await form(c);
  const values: Record<string, unknown> = {};
  for (const f of m.def.settings.fields) {
    if (f.type === 'env') continue;
    if (f.type === 'boolean') values[f.key] = bool(b[f.key]);
    else if (f.type === 'number') values[f.key] = str(b[f.key]).trim() === '' ? undefined : Number(str(b[f.key]));
    else values[f.key] = str(b[f.key]);
  }
  try {
    await saveModuleSettings(id, values);
    await audit(v.user!.id, 'module.settings', { type: 'module' }, { module: id, keys: Object.keys(values) }, v.ip);
    setFlash(c, { type: 'ok', text: 'Settings saved.' });
  } catch (e) {
    if (e instanceof ModuleStateError) setFlash(c, { type: 'error', text: e.message }); else throw e;
  }
  return c.redirect(`/admin/modules?open=${id}#module-${id}`);
});
