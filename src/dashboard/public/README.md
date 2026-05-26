# Dashboard Static Assets

## htmx.min.js

**Current file is a stub** — a no-op placeholder for CI and unit-test runs that do not exercise htmx client-side behaviour.

To vendor the real htmx before deploying to production:

```bash
# Option 1 — copy from npm package
npm install htmx.org
cp node_modules/htmx.org/dist/htmx.min.js src/dashboard/public/htmx.min.js

# Option 2 — download directly
curl -Lo src/dashboard/public/htmx.min.js \
  https://unpkg.com/htmx.org@2/dist/htmx.min.js
```

**Version**: target htmx 2.x (tested with 2.0.x).  
The stub version string is `0.0.0-stub`. After replacing, the version will appear in
`window.htmx.version` (e.g. `2.0.3`).
