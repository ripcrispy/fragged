# Test identity provider

A fake "Test identity provider" that simulates an OAuth/OIDC sign-in (choose a subject, email and verified flag),
so registration, linking and sign-in flows can be developed and tested without real provider credentials.

- **Active only when** `AUTH_DEV_PROVIDER=1` **and** `NODE_ENV` is not `production`. Startup refuses
  `AUTH_DEV_PROVIDER` in production.
- **Routes:** `/m/dev-auth/authorize` (the simulated consent screen)
- Used by the HTTP and browser test suites.
