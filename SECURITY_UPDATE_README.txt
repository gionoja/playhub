VYNQO PRIVACY + SECURITY UPDATE

This package combines the previously prepared Privacy & Account page with the new Security & Login centre.

ADDITIVE CHANGES
- Dedicated Privacy & Account hub with back navigation.
- Existing account name/password/profile-photo actions remain available.
- Existing profile visibility controls are retained.
- Blocked people list and unblock action use the existing UserBlock model and chat block endpoint.
- Dedicated Security & Login view.
- Server-side revocable authentication sessions (session IDs are stored in signed tokens and checked on every authenticated request).
- Active device/session list with browser, platform, IP address, sign-in time and last activity.
- Sign out an individual other device.
- Sign out all other devices while keeping the current device active.
- Sign out all devices, including the current one.
- Recent successful and failed login activity for accounts that exist.
- Password changes and password resets revoke previous sessions.
- Existing forgot-password recovery remains available.

IMPORTANT LIMITATIONS
- Two-factor authentication / authenticator app setup is not implemented in this release.
- Passkeys, login approval and email/push alerts for new devices are not implemented.
- The security page labels these features as unavailable; it does not expose fake switches.
- Login IP addresses are approximate network identifiers, not verified physical locations. If the app is deployed behind a reverse proxy, configure trusted proxy handling before relying on forwarded IP headers.
- Session device details are inferred from the browser User-Agent and can be incomplete.

INSTALLATION
1. Back up your current project and database.
2. Extract this package.
3. Copy the included `front` and `backend` folders into your existing project, allowing the included source files to replace their counterparts. Keep your own `.env`, database, uploads, and virtual environment.
4. Restart Flask. `db.create_all()` creates the two additive security tables (`auth_session` and `login_activity`) on startup; existing tables and records are not replaced.
5. Hard-refresh the browser (Ctrl+Shift+R) so the updated CSS and JavaScript load.

FILES CHANGED
front/index.html
front/profile.js
front/style.css
front/app.js
backend/accounts.py
backend/auth.py
backend/models.py
backend/app.py

VALIDATION
Python syntax compilation and JavaScript syntax checks passed during packaging. The existing automated tests could not be executed in this packaging environment because Flask is not installed here. Run your project's tests in its own virtual environment before deploying.
