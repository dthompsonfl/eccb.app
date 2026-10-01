--- /dev/null
# Autonomous Agent Instructions: CMS Fixes & Production Readiness (Extended)

## Background & Current Errors
The CMS is a Next.js 16.1.6 application using the app router and Turbopack. Two blockers have been reported:

1. **Hydration error on `/admin/pages/new`**
   ```
   In HTML, <li> cannot be a descendant of <li>. This will cause a hydration error.
   ```
   - **Trace:** Browser console points to `src/components/ui/breadcrumb.tsx` at line 71.
   - **Hierarchy:** `Breadcrumbs` → `BreadcrumbItem` (renders `<li>`) → `BreadcrumbSeparator` (renders `<li>`).
   - **Usage:** the breadcrumb appears in `src/app/(admin)/admin/pages/new/page.tsx` (line 14).

2. **Page creation hangs indefinitely**
   - Submitting the form on `/admin/pages/new` shows no network activity or client‑side error.
   - The server action invoked by the form never resolves nor returns data.

These two issues block CMS operation and must be fixed. In addition, the CMS codebase should be audited end‑to‑end to ensure full CRUD functionality, data validation, slug uniqueness, caching, error handling and general production readiness.

---

## 1. Fix Breadcrumb Hydration Error (Invalid HTML Nesting)

### Problem
`BreadcrumbSeparator` renders an `<li>` element. When used inside a `BreadcrumbItem` component (which itself renders an `<li>`), the resulting DOM is `<li><li>…</li></li>`, violating HTML rules and triggering a hydration error.

### Steps to Resolve
1. Open `src/components/ui/breadcrumb.tsx`.
2. Locate the `BreadcrumbSeparator` component definition.
3. Update the component to:
   - Render a `<span>` (or `<div role="presentation">`) instead of `<li>`.
   - Change its props type from `React.ComponentProps<"li">` to `React.ComponentProps<"span">`.
   - Preserve the current attributes used for styling and accessibility (`role="presentation"` and `aria-hidden="true"`).
4. Run the app and verify that `src/components/shared/breadcrumbs.tsx` no longer outputs nested `<li>` tags. Inspect the DOM via browser devtools.
5. Confirm visual styling remains identical – adjust Tailwind classes if necessary.
6. Add a unit test if one exists for breadcrumbs (optional but encouraged).

---

## 2. Fix Page Creation "Hanging" Issue

### Investigation
1. Open `src/app/(admin)/admin/pages/new/page.tsx`. Identify the `onSubmit` handler or `form` action. Note which server action is invoked; it should reference `createPage` from `src/app/(admin)/admin/pages/actions.ts` but there may also be a legacy/alternate `src/app/actions/cms.ts` file elsewhere in the repo – locate both and determine which one the UI actually uses.
2. Open the referenced action(s). In the current repo the `createPage` action looks like this:
   ```ts
   export async function createPage(formData: FormData) {
     // permission check, parse FormData, validate via Zod
     const page = await prisma.page.create({ ... });
     await auditLog(...);
     await invalidatePageCache(page.slug);
     revalidatePath('/admin/pages');
     revalidatePath(`/${page.slug}`);
     return { success: true, pageId: page.id };
   }
   ```
3. Examine for the following anti‑patterns or omissions:
   - **Catching but not re‑throwing redirects/errors.** Although these actions currently don't call `redirect`, check any other server actions (e.g. delete handlers) for this pattern.
   - **Missing `await` keywords** on Prisma calls, audit logs, or cache invalidation; ensure no promise is forgotten.
   - **Failure to return a value**; every branch (success or catch) should return an object so the client promise resolves.
   - **Unused session variables** – this file previously imported `getSession` and assigned `session`; lint warnings indicate they were unused. Confirm that permission checks use `requirePermission` and drop dead code.
4. Also verify the corresponding client component (`PageForm` in `src/components/admin/pages/page-form.tsx`) handles the action result, toggles `isSubmitting`, and displays toast messages on error. If the form doesn't process `result.success`, the UI may hang even though the action completed.

### Fixes to Apply
- Confirm server actions always return a value and do not swallow redirects or errors in catch blocks. If any action does perform a `redirect()`, ensure the redirect error is re‑thrown or executed outside the catch.
- Ensure all asynchronous database operations (Prisma, service calls, audit logs, cache invalidations) are preceded by `await` and that the function is declared `async`.
- After successful creation/update/delete, return an object such as `{ success: true, pageId?: string }` so clients can react.
- In catch blocks, convert known errors (Zod validation, Prisma unique constraint) into user-friendly messages and return them rather than letting the action abort silently.
- Update the client form component (`PageForm`): toggle `isSubmitting`, display a toast on error, and redirect the user client‑side based on the returned `pageId` instead of relying on server‑side redirects.

### Additional Diagnostics
- Run `npm dev` and reproduce the hang while watching the terminal for server errors; unhandled promise rejections will surface there.
- Add temporary `console.log` statements if necessary to trace execution flow.

---

## 3. CMS Codebase Review & Completeness Checklist
For each file listed below, conduct a thorough review. The goal is to ensure the admin UI can fully manage public pages without developer intervention.

### Files To Audit
- `src/app/(admin)/admin/pages/page.tsx` – listing page with links to edit/delete
- `src/app/(admin)/admin/pages/new/page.tsx` – create form page
- `src/app/(admin)/admin/pages/[id]/page.tsx` – edit form page
- `src/app/(admin)/admin/pages/actions.ts` – server actions used by forms
- `src/app/actions/cms.ts` (and any other `src/app/actions/*`) – legacy/general CMS actions; decide whether they are still needed or should be removed/merged and fix any type/any warnings
- `src/lib/services/cms.service.ts` – service layer interacting with Prisma and cache
- any additional API routes under `src/app/api` (e.g. `src/app/api/cms/pages/…`)

### Review Checklist
1. **Create**
   - Form fields: title, slug, content (rich text/markdown)
   - Zod schema validating input before database call
   - Slug uniqueness check (try/catch Prisma known error or explicit `findUnique`/`findFirst`)
2. **Read**
   - List view fetches pages from the database
   - Pagination or sorting? Ensure it functions
3. **Update**
   - Edit page pre-populates fields from DB
   - Changes are validated and persisted
   - After update, redirect back to list or show success message
4. **Delete**
   - Delete button with confirmation
   - Server action deletes record and invalidates cache
5. **Slug Handling**
   - Database schema may have a unique index. Ensure code catches duplicates and presents a user-friendly message.
   - Consider lowercasing/sluggifying the input.
6. **Validation**
   - Use Zod schemas in actions or service layer.
   - On validation failure, throw an error the client can display.
7. **Error Handling**
   - Catch Prisma errors (e.g. `P2002` uniqueness) and convert to readable messages.
   - If a service call fails, the error should propagate to the form and display a toast.
8. **Caching**
   - `cms.service.ts` should have functions such as `getPage`, `getPages`, `createPage`, `updatePage`, `deletePage`.
   - After `create`, `update`, or `delete`, ensure any in‑memory or redis cache is invalidated (e.g. `revalidatePath('/pages')`).
9. **Permissions**
   - Actions should call `requirePermission('cms.pages.manage')` or similar.
   - `session` or `getSession` may have been imported but not used — remove or leverage correctly.
10. **API Routes**
    - If the UI uses API routes instead of server actions, ensure the routes exist and return appropriate HTTP statuses.
11. **Styling & UX**
    - Ensure the admin pages are responsive and accessible.
    - Use loading spinners or optimistic UI where appropriate.
12. **Tests**
    - Add or update unit/feature tests (`*.test.tsx`) for page actions.
13. **Static/Public Page Rendering**
    - Verify that pages created in the CMS are rendered on the public site (`/pages/[slug]`).
    - Check caching/ISR behavior if implemented.

### Production Readiness Items
- Run `npm run lint` and fix any warnings/errors from the reviewed files, paying particular attention to `src/app/(admin)/admin/pages/actions.ts` (unused vars) and `src/app/actions/cms.ts` (any-type warnings).
- Run `npm run build` to ensure the project compiles cleanly.
- Type‑check (`npm run typecheck` or `npm tsc --noEmit`).
- Review `prisma/schema.prisma` for appropriate constraints (slug unique, required fields) and verify migrations have been generated and applied.
- Confirm `seed.ts` or migrations include initial CMS pages and that they load without errors.
- Search for `CmsService` usage and ensure the public route (`src/app/(public)/[...slug]/page.tsx`) correctly handles reserved slugs, scheduled publishing, and sanitizes HTML.
- Check that there are tests covering page actions or add them if missing; the existing `cms.service` tests should be expanded to include action-level behaviour if possible.

---

## 4. Linting Cleanup in `actions.ts`
The linter reports:
```
/home/dylan.eccb.app/src/app/(admin)/admin/pages/actions.ts
    5:29  warning  'getSession' is defined but never used
  182:9   warning  'session' is assigned a value but never used
  270:9   warning  'session' is assigned a value but never used
  322:9   warning  'session' is assigned a value but never used
```

### Steps
- Remove the unused import of `getSession` at the top of the file.
- Remove or utilize the `session` variables. If they were meant to enforce permissions, use `requirePermission` or check user role and document this in comments.
- Additionally review `src/app/actions/cms.ts` for lint warnings (the `any` types) and either tighten its TypeScript signatures or remove the file if it is no longer in use.
- After edits, run the linter again to ensure no unused variables or `any` warnings remain.

---

## 5. Implementation Plan (Order of Operations)
1. Refactor `src/components/ui/breadcrumb.tsx` and verify the hydration error is resolved.
2. Examine and fix the server action used by the new page form (likely in `src/app/(admin)/admin/pages/actions.ts`).
   - Correct redirect placement, awaits, return values, and error handling.
3. Clean up lint warnings in `actions.ts` (remove unused variables).
4. Conduct the comprehensive CMS review described in section 3.
   - Fix any missing API routes, validation, caching, or CRUD holes.
5. Address any additional issues that surface during testing (missing imports, typos, broken links).
6. Run full build, typecheck, and lint to validate readiness.
7. Add or update tests to cover the new fixes and CRUD flows.

---

## 6. Verification
- **Breadcrumbs:** navigate to any admin route that renders breadcrumbs (e.g. `/admin/pages/new`, `/admin/events/123/edit`) and confirm no hydration warnings.
- **Create Page:** fill out and submit the form at `/admin/pages/new`; ensure page is created, list view updates, and the browser navigates back to `/admin/pages` with a success message. If the UI still hangs, inspect the network/devtools and server logs to determine if the action response is missing or the client code is broken.
- **Edit/Delete Page:** modify a page, save, delete; observe expected behavior and no hangs. Verify `isSubmitting` toggles properly and toasts show error messages.
- **Legacy Actions:** confirm whether `src/app/actions/cms.ts` is used; if it is unused, remove or refactor it so it doesn’t confuse developers.
- **Slug Uniqueness:** attempt to create two pages with the same slug and verify a friendly error is shown.
- **Reserved & Scheduled Pages:** on the public site, reserved slugs (e.g. `admin`, `login`) should return 404. Create a page with a future `scheduledFor` date and confirm it isn’t accessible until the scheduled time.
- **Public Rendering:** visit a slug generated by the CMS and confirm the page displays correctly; content should sanitize HTML and render markdown appropriately.
- **Cache Invalidation:** after editing or deleting a page, reload the public page or run `npm run preview` to see changes reflected immediately; if possible inspect cache keys.
- **Lint/Build:** no lint warnings/errors and `npm run build` succeeds.

---

Follow these instructions step by step and make sure the CMS is fully operational and production ready for a non-technical user to manage publicly visible pages via the `/admin` portal.
