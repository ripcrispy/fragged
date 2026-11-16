# Media embeds

Turns YouTube, Vimeo and Spotify links in posts, messages and profiles into **click-to-load** players. Nothing is
requested from the third party until the reader clicks. YouTube uses the privacy-enhanced `youtube-nocookie.com`
host.

- **Permissions:** uses the core `post.embed_media` permission for the `[media]` tag
- **Settings:** none · **Data:** none
- While enabled, the embed origins are added to the Content Security Policy `frame-src`. While disabled, links stay
  plain links.

## Adding a provider

Providers live in `providers.ts`. A provider maps a URL to a **fixed** embed URL built from validated ids, never
arbitrary HTML:

```ts
{ id: 'example', name: 'Example', embedOrigins: ['https://player.example.com'],
  match(url) { const id = /^\/v\/([\w-]{6,20})$/.exec(url.pathname)?.[1];
    return url.hostname === 'example.com' && id ? { kind: 'video', aspect: 'video', embedUrl: `https://player.example.com/embed/${id}` } : null; } }
```

The resolver rejects embed URLs outside the provider's declared `embedOrigins`.
