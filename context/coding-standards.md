# Coding Standards

A short version of the GMT standards, cut down to what applies to this site.
Styling and config rules are in [CLAUDE.md § Rules](../CLAUDE.md#rules).

## Functions

- Declare named functions with the `function` keyword, not
  `const name = () => …`. Arrow functions are for inline callbacks only.
- Name a function for what it does or returns: `randomBetween`, not `rand`;
  `requestTimes`, not `want`. Short parameter names are fine where they are
  the maths convention (`a`, `b`, `k`).
- No IIFEs. To compute a value once, write a named function and call it:

  ```ts
  function bodyTriangles(): V[] {
    // …
  }

  const BODY_TRIS = bodyTriangles();
  ```

## Time

- No `Date` object. Clock reads, time zones and formatting go through
  `@northguild/gmt`. `oxlint` enforces this with `@northguild/gmt-oxlint`.

## Errors

- Wrap anything that can throw on input the page does not control (storage,
  parsing, browser APIs that may be blocked) in `try`/`catch`. Use a bare
  `catch { … }` and return a safe default. Never let it break the page.

## Loops

- Avoid `while` loops. Prefer bounded `for` loops or array methods (`map`,
  `filter`, `reduce`).

## The sky

- Keep work off the main thread. Rendering and sky maths run in
  `aurora.worker.ts`; the page script only posts messages and updates the DOM.

## Writing

- Comments, commit messages and PR text are in plain English: the reader
  understands it first time. Say why, not what the code already says.

## Before handing off

Run what CI runs:

```sh
pnpm lint && pnpm format:check && pnpm check && pnpm build
```
