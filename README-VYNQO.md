# Vynqo UI upgrade

This archive contains the existing PlayHub project with a visual refresh toward the Vynqo brand.

## Changes made
- Rebranded the browser title, account-entry screen, and app header to Vynqo.
- Added a responsive welcome/hero area and top-level Log in / Create account actions.
- Added a coordinated purple, blue, and cyan design language with refined forms, cards, feed posts, and focus states.
- Improved small-screen layout and added reduced-motion support.
- Hardened theme preference handling and synchronizes theme changes across open tabs. The existing `darkMode` localStorage key is retained so saved preferences continue to work across logout/login and reloads.

## Run notes
- Existing backend and frontend feature files are retained.
- Configure your local backend environment variables before running; `.env` and local database files are intentionally not bundled for safety/privacy.
- Check the API base URL in `front/app.js` for your own development/deployment setup before running outside the original local environment.

## Validation
- `front/app.js` passed `node --check`.
- `front/index.html` passed Python's HTML parser.
- Full end-to-end browser/backend tests were not run in this environment.
