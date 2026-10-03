# Accessibility Strategy (WCAG 2.1 AA)

This document outlines the accessibility standards, guidelines, and implementation patterns for the Emerald Coast Community Band website to ensure WCAG 2.1 AA compliance.

## Table of Contents

1. [Overview](#overview)
2. [WCAG 2.1 AA Compliance Checklist](#wcag-21-aa-compliance-checklist)
3. [Keyboard Navigation](#keyboard-navigation)
4. [Screen Reader Support](#screen-reader-support)
5. [Color Contrast Requirements](#color-contrast-requirements)
6. [Focus Management](#focus-management)
7. [ARIA Usage Guidelines](#aria-usage-guidelines)
8. [Testing Procedures](#testing-procedures)
9. [Component-Specific Guidelines](#component-specific-guidelines)

---

## Overview

### Target Compliance Level
- **WCAG 2.1 Level AA** - The standard for most accessibility regulations worldwide

### Core Principles (POUR)
1. **Perceivable** - Information must be presentable in ways users can perceive
2. **Operable** - Interface components must be operable by all users
3. **Understandable** - Information and UI operation must be understandable
4. **Robust** - Content must be robust enough for diverse user agents

### Technology Stack Accessibility Features
- **Radix UI Primitives**: Built-in ARIA attributes, keyboard navigation, and focus management
- **Tailwind CSS**: Focus-visible utilities, screen reader classes
- **React 19**: Improved accessibility patterns and error handling

---

## WCAG 2.1 AA Compliance Checklist

### 1. Perceivable

#### 1.1 Text Alternatives
- [ ] All images have meaningful `alt` text (decorative images use `alt=""`)
- [ ] Complex images have extended descriptions
- [ ] Image buttons have descriptive alt text
- [ ] SVG icons have `aria-hidden="true"` when decorative, or proper labels when functional

#### 1.2 Time-based Media
- [ ] Videos have captions
- [ ] Audio content has transcripts
- [ ] No auto-playing media without user control

#### 1.3 Adaptable
- [ ] Proper heading hierarchy (h1 → h2 → h3, no skipping levels)
- [ ] Form inputs have associated labels
- [ ] Data tables have proper headers
- [ ] Reading sequence is logical

#### 1.4 Distinguishable
- [ ] Color contrast ratio ≥ 4.5:1 for normal text
- [ ] Color contrast ratio ≥ 3:1 for large text (18pt+ or 14pt bold)
- [ ] Color contrast ratio ≥ 3:1 for UI components
- [ ] Text can be resized up to 200% without loss of functionality
- [ ] No information conveyed by color alone

### 2. Operable

#### 2.1 Keyboard Accessible
- [ ] All functionality available via keyboard
- [ ] No keyboard traps
- [ ] Skip-to-content link provided
- [ ] Focus order is logical

#### 2.2 Enough Time
- [ ] Time limits can be extended
- [ ] No unexpected time limits
- [ ] Moving content can be paused

#### 2.3 Seizures and Physical Reactions
- [ ] No content flashes more than 3 times per second
- [ ] `prefers-reduced-motion` is respected

#### 2.4 Navigable
- [ ] Pages have descriptive titles
- [ ] Focus is visible on all interactive elements
- [ ] Multiple ways to find pages (navigation, search, sitemap)
- [ ] Link purpose is clear from link text or context

#### 2.5 Input Modalities
- [ ] Touch targets are at least 44×44 CSS pixels
- [ ] Gestures have single-pointer alternatives
- [ ] Motion-activated features have alternatives

### 3. Understandable

#### 3.1 Readable
- [ ] Page language is set (`lang="en"`)
- [ ] Language changes are marked
- [ ] Abbreviations have explanations

#### 3.2 Predictable
- [ ] Focus doesn't trigger unexpected context changes
- [ ] Form inputs don't auto-submit without warning
- [ ] Navigation is consistent across pages

#### 3.3 Input Assistance
- [ ] Form errors are clearly identified
- [ ] Form inputs have labels and instructions
- [ ] Error suggestions are provided
- [ ] Legal/financial actions can be reversed

### 4. Robust

#### 4.1 Compatible
- [ ] Valid HTML markup
- [ ] ARIA attributes are used correctly
- [ ] Status messages use appropriate roles
- [ ] Name, Role, Value for all UI components

---

## Keyboard Navigation

### Standard Keybindings

| Key | Action |
|-----|--------|
| `Tab` | Move to next focusable element |
| `Shift + Tab` | Move to previous focusable element |
| `Enter` | Activate buttons, links, and menu items |
| `Space` | Activate buttons, toggle checkboxes |
| `Escape` | Close modals, dropdowns, and menus |
| `Arrow Up/Down` | Navigate within lists, menus, and comboboxes |
| `Arrow Left/Right` | Navigate within horizontal menus, sliders |
| `Home` | Jump to first item in a list |
| `End` | Jump to last item in a list |

### Implementation Guidelines

```tsx
// Always provide keyboard event handlers
const handleKeyDown = (event: React.KeyboardEvent) => {
  switch (event.key) {
    case 'Enter':
    case ' ':
      event.preventDefault();
      handleActivate();
      break;
    case 'Escape':
      handleClose();
      break;
  }
};
```

### Focus Trap for Modals

Modals and dialogs must trap focus within them while open. Radix UI primitives handle this automatically.

```tsx
// Radix Dialog handles focus trapping automatically
<Dialog.Root>
  <Dialog.Content>
    {/* Focus is trapped here while open */}
  </Dialog.Content>
</Dialog.Root>
```

### Skip-to-Content Link

Every page must have a skip-to-content link as the first focusable element:

```tsx
<a
  href="#main-content"
  className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-primary focus:text-white focus:rounded-md"
>
  Skip to main content
</a>
<main id="main-content">
  {/* Page content */}
</main>
```

---

## Screen Reader Support

### Supported Screen Readers

| Platform | Screen Reader | Browser |
|----------|---------------|---------|
| Windows | NVDA | Firefox, Chrome |
| Windows | JAWS | Chrome, Edge |
| macOS | VoiceOver | Safari, Chrome |
| iOS | VoiceOver | Safari |
| Android | TalkBack | Chrome |

### Screen Reader Announcements

#### Live Regions

```tsx
// Polite announcements (don't interrupt)
<div role="status" aria-live="polite">
  {statusMessage}
</div>

// Assertive announcements (interrupt immediately)
<div role="alert" aria-live="assertive">
  {errorMessage}
</div>
```

#### Visually Hidden Content

Use the `sr-only` class for content that should be announced but not visible:

```tsx
<span className="sr-only">Loading content, please wait</span>
```

### Image Alt Text Guidelines

```tsx
// Informative image
<img src="band-concert.jpg" alt="The Emerald Coast Community Band performing at the spring concert" />

// Decorative image
<img src="decorative-border.png" alt="" aria-hidden="true" />

// Functional image
<button aria-label="Play video">
  <PlayIcon aria-hidden="true" />
</button>
```

---

## Color Contrast Requirements

### Design System Colors

| Color | Hex | Usage | Contrast (on white) |
|-------|-----|-------|---------------------|
| Primary | `#0f766e` | Buttons, links | 5.47:1 ✓ |
| Primary Light | `#5eead4` | Accents, **dark-mode focus ring** | 2.12:1 ✗ on white / 9.89:1 on the dark card ✓ |
| Neutral Dark | `#1f2937` | Text | 13.5:1 ✓ |
| Accent | `#f59e0b` | Highlights | 2.15:1 ✗ (use on dark only) |
| Muted foreground | `#616771` | Helper text | 5.6:1 on background, 5.18:1 on muted ✓ |

`--muted-foreground` was `#6b7280` until it was measured at **4.39:1 on
`--muted`**, an AA failure. Muted helper text is very often set *on* a muted
surface (muted cards, muted table rows), so the token has to clear 4.5:1 against
both `--background` and `--muted`. Do not lighten it again.

### The focus ring is its own token

`--focus-ring` is deliberately **not** `--primary`. `--primary` is a fill
colour chosen to sit behind white text; as a 3px outline on a dark card it
measured only **2.67:1**, i.e. dark mode had a focus ring nobody could see.
`--focus-ring` is `#0f766e` in light and `#5eead4` in dark, and every primitive
in `src/components/ui/` uses it at full opacity. The old `ring-ring/50` pattern
must not come back: 50% opacity teal on white is 2.16:1.

### Contrast Rules

- **Normal text (< 18pt)**: Minimum 4.5:1 contrast ratio
- **Large text (≥ 18pt or 14pt bold)**: Minimum 3:1 contrast ratio
- **UI components**: Minimum 3:1 contrast ratio against adjacent colors
- **Focus indicators**: Minimum 3:1 contrast ratio against adjacent colors

### Testing Colors

Use these tools to verify contrast:
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [Colour Contrast Analyser](https://www.tpgi.com/color-contrast-checker/)
- Browser DevTools accessibility inspectors

---

## Destructive Actions

Anything that destroys a member's work — removing a bookmark, deleting a
setlist, taking a carpool post off the board — must go through
`ConfirmActionButton` (`src/components/member/shared/confirm-action-button.tsx`).

The audience for this app skews elderly, uses a shaky hand, and is often
frustrated when something goes wrong. A single tap of a small trash icon that
silently destroys work is the worst possible outcome: it is unrecoverable, and
it teaches the member that the app is not to be trusted.

The component enforces three things:

1. **Nothing is destroyed on the first tap.** The first tap arms a confirmation
   dialog that names the item and states the consequence in plain words.
2. **The trigger is at least 44×44 px**, regardless of the icon size inside it.
3. **Where the work can be re-created, an undo toast is offered** rather than
   only a permission slip. Undo is kinder than "are you sure?", because it does
   not require the member to understand what went wrong before they recover.

The dialog's escape hatch is worded **"Keep it"**, not "Cancel" — a member who
mis-taps should never have to guess which button undoes the mistake.

```tsx
<ConfirmActionButton
  itemName={`the setlist "${setlist.name}"`}
  confirmTitle="Delete this setlist?"
  confirmDescription={`"${setlist.name}" will be taken off this concert. This cannot be undone.`}
  onConfirm={() => handleDelete(setlist.id)}
  successMessage={`Setlist deleted — ${setlist.name}`}
  aria-label={`Delete setlist ${setlist.name}`}
>
  <Trash2Icon className="h-3.5 w-3.5" />
</ConfirmActionButton>
```

Every action must also give a **definite** result — a success toast, or an error
toast that says in plain language that nothing changed. Errors from the server
(`Prisma P2003`, `fetch failed`, HTTP status codes) are logged to the console
and never shown to a member.

---

## Focus Management

### Focus Visible Styles

All interactive elements must have visible focus indicators:

```css
/* Global focus styles — 3px, not 2px: a member with a tremor needs a target
   they can see hold still. --focus-ring clears 3:1 in both themes. */
*:focus-visible {
  outline: 3px solid var(--focus-ring);
  outline-offset: 2px;
}

/* Remove default outline when not using keyboard */
*:focus:not(:focus-visible) {
  outline: none;
}
```

Shadcn primitives (`Button`, `Input`, `Select`, `Checkbox`, `Switch`, …) carry
`outline-none` plus their own `focus-visible:ring-focus-ring`. Because the
primitive supplies the ring, `outline-none` there is acceptable — but the ring
must be at **full opacity** and must use `--focus-ring`, never `--ring/50`.

`src/lib/accessibility/__tests__/design-token-contrast.test.ts` enforces all of
the ratios above as executable assertions, so a future palette tidy-up cannot
silently reintroduce an unreadable helper colour or an invisible focus ring.

### Focus Restoration

When closing modals or dialogs, restore focus to the trigger element:

```tsx
// Radix UI handles this automatically
// For custom implementations:
const [triggerElement, setTriggerElement] = useState<HTMLElement | null>(null);

const handleOpen = (event: React.MouseEvent) => {
  setTriggerElement(event.currentTarget);
  setIsOpen(true);
};

const handleClose = () => {
  setIsOpen(false);
  triggerElement?.focus();
};
```

### Focus Within Complex Components

For components like dropdowns and menus:

```tsx
// Use roving tabindex pattern
const [focusedIndex, setFocusedIndex] = useState(-1);

const handleKeyDown = (event: React.KeyboardEvent) => {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      setFocusedIndex(Math.min(focusedIndex + 1, items.length - 1));
      break;
    case 'ArrowUp':
      event.preventDefault();
      setFocusedIndex(Math.max(focusedIndex - 1, 0));
      break;
  }
};
```

---

## ARIA Usage Guidelines

### When to Use ARIA

1. **First rule**: Use native HTML elements when possible
2. **Second rule**: Don't change native semantics unless necessary
3. **Third rule**: All interactive elements must be keyboard accessible
4. **Fourth rule**: Don't hide visible focus indicators
5. **Fifth rule**: Use ARIA for what it's designed for

### Common ARIA Patterns

#### Landmarks

```tsx
<header role="banner">
<nav role="navigation" aria-label="Main navigation">
<main role="main" id="main-content">
<aside role="complementary">
<footer role="contentinfo">
```

#### Buttons vs Links

```tsx
// Button: triggers an action
<button onClick={handleClick}>Submit form</button>

// Link: navigates to a new location
<a href="/about">About us</a>

// Never use divs or spans as interactive elements
// ❌ Bad
<div onClick={handleClick}>Click me</div>

// ✓ Good
<button onClick={handleClick}>Click me</button>
```

#### Form Labels

```tsx
// Explicit labeling
<label htmlFor="email">Email address</label>
<input id="email" type="email" />

// Implicit labeling
<label>
  Email address
  <input type="email" />
</label>

// Using aria-label (when visual label isn't possible)
<input type="search" aria-label="Search site" />

// Using aria-labelledby
<span id="search-label">Search</span>
<input aria-labelledby="search-label" type="search" />
```

#### Required Fields

```tsx
<label htmlFor="name">
  Name <span aria-hidden="true">*</span>
  <span className="sr-only">(required)</span>
</label>
<input id="name" required aria-required="true" />
```

#### Error Messages

```tsx
<label htmlFor="email">Email</label>
<input
  id="email"
  aria-invalid={hasError}
  aria-describedby={hasError ? 'email-error' : undefined}
/>
{hasError && (
  <p id="email-error" role="alert">
    Please enter a valid email address
  </p>
)}
```

#### Expandable Content

```tsx
<button
  aria-expanded={isOpen}
  aria-controls="panel-content"
  onClick={() => setIsOpen(!isOpen)}
>
  {isOpen ? 'Hide' : 'Show'} details
</button>
<div id="panel-content" hidden={!isOpen}>
  {/* Content */}
</div>
```

---

## Testing Procedures

### Automated Testing

#### Lighthouse (Chrome DevTools)
```bash
# Run Lighthouse audit
npx lighthouse https://localhost:3000 --only-categories=accessibility
```

#### axe-core Integration
```bash
# Install axe-core for automated testing
npm install --save-dev @axe-core/react
```

#### Jest-axe for Unit Tests
```typescript
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

it('should have no accessibility violations', async () => {
  const { container } = render(<MyComponent />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

### Manual Testing Checklist

#### Keyboard Testing
- [ ] Tab through all interactive elements
- [ ] Verify focus order is logical
- [ ] Test all functionality with keyboard only
- [ ] Check for keyboard traps
- [ ] Verify skip-to-content link works

#### Screen Reader Testing
- [ ] Test with NVDA (Windows)
- [ ] Test with VoiceOver (macOS/iOS)
- [ ] Verify all images have appropriate alt text
- [ ] Check heading hierarchy
- [ ] Verify form labels are announced
- [ ] Test dynamic content announcements

#### Visual Testing
- [ ] Test at 200% zoom
- [ ] Test at 400% zoom
- [ ] Verify high contrast mode
- [ ] Check color contrast ratios
- [ ] Test with different color vision deficiencies

### Testing Schedule

| Type | Frequency | Tools |
|------|-----------|-------|
| Automated | Every PR | axe-core, Lighthouse |
| Keyboard | Every release | Manual |
| Screen Reader | Every release | NVDA, VoiceOver |
| Color Contrast | Design changes | WebAIM, CCA |

---

## Component-Specific Guidelines

### Buttons

```tsx
// Standard button
<Button>Click me</Button>

// Icon button with accessible name
<Button aria-label="Close dialog">
  <XIcon aria-hidden="true" />
</Button>

// Toggle button
<Button
  aria-pressed={isPressed}
  onClick={() => setIsPressed(!isPressed)}
>
  {isPressed ? 'On' : 'Off'}
</Button>
```

### Forms

```tsx
<form aria-label="Contact form">
  <fieldset>
    <legend>Personal Information</legend>
    
    <div>
      <label htmlFor="name">Name</label>
      <input id="name" type="text" required />
    </div>
    
    <div>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" required />
    </div>
  </fieldset>
  
  <button type="submit">Submit</button>
</form>
```

### Navigation

```tsx
<nav aria-label="Main navigation">
  <ul role="list">
    <li><a href="/">Home</a></li>
    <li><a href="/about">About</a></li>
    <li><a href="/events">Events</a></li>
  </ul>
</nav>
```

### Data Tables

```tsx
<table>
  <caption>Upcoming Events</caption>
  <thead>
    <tr>
      <th scope="col">Event</th>
      <th scope="col">Date</th>
      <th scope="col">Location</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">Spring Concert</th>
      <td>March 15, 2024</td>
      <td>Main Hall</td>
    </tr>
  </tbody>
</table>
```

### Modals/Dialogs

```tsx
<Dialog.Root>
  <Dialog.Trigger asChild>
    <Button>Open dialog</Button>
  </Dialog.Trigger>
  
  <Dialog.Content aria-describedby={undefined}>
    <Dialog.Title>Dialog Title</Dialog.Title>
    <Dialog.Description>
      This describes the dialog purpose.
    </Dialog.Description>
    
    {/* Dialog content */}
    
    <Dialog.Close asChild>
      <Button>Close</Button>
    </Dialog.Close>
  </Dialog.Content>
</Dialog.Root>
```

### Tabs

```tsx
<Tabs.Root defaultValue="tab1">
  <Tabs.List aria-label="Content sections">
    <Tabs.Trigger value="tab1">Section 1</Tabs.Trigger>
    <Tabs.Trigger value="tab2">Section 2</Tabs.Trigger>
  </Tabs.List>
  
  <Tabs.Content value="tab1">
    Content for section 1
  </Tabs.Content>
  
  <Tabs.Content value="tab2">
    Content for section 2
  </Tabs.Content>
</Tabs.Root>
```

### Loading States

```tsx
// Spinner with announcement
<div role="status" aria-live="polite">
  <Spinner aria-hidden="true" />
  <span className="sr-only">Loading content, please wait</span>
</div>

// Skeleton loading
<div aria-hidden="true" aria-busy="true">
  <Skeleton />
</div>
```

---

## Resources

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [Radix UI Accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility)
- [WebAIM Resources](https://webaim.org/resources/)
- [MDN Accessibility Guide](https://developer.mozilla.org/en-US/docs/Web/Accessibility)
