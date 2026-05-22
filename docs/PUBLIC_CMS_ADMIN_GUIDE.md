# Public CMS Administration Guide

This guide covers the production CMS surfaces added for public-site content that should not require code changes.

## Admin routes

| Route | Purpose | Required permission |
| --- | --- | --- |
| `/admin/leadership` | Manage directors, board members, staff, and volunteer leadership bios shown on `/directors` | `cms.view.all` / `cms.edit` |
| `/admin/sponsors` | Manage sponsors and partner listings shown on `/sponsors` | `cms.view.all` / `cms.edit` |
| `/admin/gallery` | Manage gallery albums and public gallery images shown on `/gallery` | `cms.view.all` / `cms.edit` |
| `/admin/contact-submissions` | Review, triage, and resolve public contact form messages | `cms.view.all` / `cms.edit` |

Delete actions require `cms.delete`.

## Public routes powered by CMS data

| Public route | Source model |
| --- | --- |
| `/directors` | `LeadershipProfile` |
| `/sponsors` | `Sponsor` |
| `/gallery` | `GalleryAlbum`, `GalleryImage` |
| `/contact` | Persists to `ContactSubmission` and sends email notifications |

## Publishing behavior

- Leadership profiles appear publicly only when `isPublished = true`.
- Gallery albums appear publicly only when `isPublished = true`.
- Gallery images appear publicly only when `isPublished = true`.
- Sponsors appear publicly only when `isActive = true` and the current date is inside the optional start/end window.
- Contact submissions are always persisted before notification emails are sent.

## Operational workflow

### Leadership

1. Go to `/admin/leadership`.
2. Create a profile with name, role, profile type, optional bio, optional photo URL, optional public email, and sort order.
3. Mark **Publish profile** only when the bio and image are approved.
4. Review `/directors` after saving.

### Sponsors

1. Go to `/admin/sponsors`.
2. Create a sponsor with name, level, website, logo URL, description, sort order, and public visibility.
3. Mark **Show publicly** when the sponsor listing is approved.
4. Review `/sponsors` after saving.

### Gallery

1. Go to `/admin/gallery`.
2. Create one or more albums.
3. Add images to albums with accessible alt text.
4. Publish albums and images only after confirming usage rights.
5. Review `/gallery` after saving.

### Contact submissions

1. Go to `/admin/contact-submissions`.
2. Review new messages.
3. Mark messages as `READ`, `REPLIED`, `RESOLVED`, or `ARCHIVED`.
4. Record internal notes for follow-up accountability.

## Data protection notes

- Contact submissions may contain personal information and must be treated as private operational records.
- Do not publish private contact details without consent.
- Use descriptive gallery alt text for accessibility.
- Sponsor logos and gallery images should only be published when ECCB has usage rights.

## Release verification

After applying the public CMS migration, verify:

```bash
pnpm run db:generate
pnpm run db:migrate:deploy
pnpm run typecheck
pnpm run lint
pnpm run test:run
pnpm run build
```

Then smoke-test:

- `/admin/leadership` create/edit/delete profile
- `/directors` renders published profile
- `/admin/sponsors` create/edit/delete sponsor
- `/sponsors` renders active sponsor
- `/admin/gallery` create/edit/delete album and image
- `/gallery` renders published image
- `/contact` creates a persisted `ContactSubmission`
- `/admin/contact-submissions` updates message status
