# LwLAT Trip Planner

Trip registers for the trust's five schools.

- **Trip organisers** sign in with Microsoft (Entra single sign-on, the same account as Pulse) and set up trips. Each trip has a pupil CSV, a trip lead and the staff going.
- **Staff going on the trip** each get an email with their own password. On the day they log in on any phone with their work email and that password. They can take the morning register, any optional check-ins and the end-of-day check, which shows whether each child is collected (and by whom) or making their own way home.
- **Everything is traceable:** who set up a trip, who marked each child, who changed a home arrangement, and who added or removed a pupil on the day, with their reason.

## Who can do what

| Person | How they get in | Can |
|---|---|---|
| **Trust admin** | Microsoft sign-in | Set each school's email domains and trip organisers, add other trust admins, see every school's trips, see the full activity log |
| **Trip organiser** (named per school in Trust admin) | Microsoft sign-in | Create trips for their school(s), add or remove staff, reset and resend passwords, change trip details, close, reopen and delete trips, see their schools' activity log |
| **Staff on a trip** | Trip login (work email + personal password), **or** Microsoft sign-in | Only that trip: take registers, see medical and emergency contact details, change home arrangements, add check-ins, and add, edit or remove pupils (with a reason). They can't change trip details or staff, and can't delete trips |

Trip logins work from **6am on the first day of the trip until midnight on the last day** (UK time). They stop early if the trip is closed, the person is removed, or their password is reset. Only addresses on an LwLAT email domain (set in Trust admin) can be added as trip staff.

### What's recorded

- **Trip set-up:** who created it (name and email from Microsoft) and when, shown on the trip and in the report.
- **Every register mark:** who made it (name and email) and when.
- **Pupils added on the day:** flagged "Added on the day", with who added them, when and why. This appears on the register, in the report and in the CSV.
- **Pupils removed:** kept in a "Removed from trip" list with who removed them, when and why. They're never silently deleted.
- **Edits to a pupil:** logged with the old and new values.
- **Trip log** (Manage trip → Trip log): every action on that trip.
- **Activity log** (trust-wide): trips created, edited, closed and deleted; staff added or removed; passwords reset; pupils added or removed on the day; changes to trust settings.

---

## Setting it up

You'll need: a **private GitHub repository**, a **Netlify** site, and someone with **Entra admin** rights (IT).

### 1. GitHub and Netlify

1. Create a **private** GitHub repository and upload everything in this folder.
2. In Netlify: *Add new site → Import an existing project → GitHub*, then pick the repository. Build settings come from `netlify.toml`, so leave them alone.
3. Note the site address, e.g. `https://lwlat-trips.netlify.app` (or your own domain if you add one).

### 2. Entra app registration (IT)

In the **Microsoft Entra admin centre → App registrations → New registration**:

1. **Name:** `LwLAT Trip Planner`
2. **Supported account types:** *Accounts in this organizational directory only* (single tenant).
3. **Redirect URI:** platform **Web**, value `https://<your-site>/api/auth/callback`.
4. Register, then copy the **Application (client) ID** and **Directory (tenant) ID**.
5. **Certificates & secrets → New client secret.** Copy the secret **value**. Note when it expires and put a reminder in the calendar to renew it.
6. **API permissions:**
   - Microsoft Graph → **Delegated**: `openid`, `profile`, `email` (for sign-in).
   - Microsoft Graph → **Application**: `Mail.Send` (to email trip logins).
   - Select **Grant admin consent**.
7. **Mail sending:**
   - Create or choose a mailbox to send from, e.g. a shared mailbox `trips@lwlat.org.uk`.
   - **Strongly recommended:** restrict the app so it can only send as that mailbox. In Exchange Online PowerShell, use an *Application Access Policy* (`New-ApplicationAccessPolicy -AccessRight RestrictAccess -AppId <client id> -PolicyScopeGroupId <mail-enabled group containing only the trips mailbox>`). Without this, `Mail.Send` would let the app send as any mailbox.

### 3. Netlify environment variables

In *Site configuration → Environment variables*:

| Variable | Value |
|---|---|
| `SESSION_SECRET` | A long random string (40+ characters). Changing it signs everyone out. |
| `ENTRA_TENANT_ID` | Directory (tenant) ID |
| `ENTRA_CLIENT_ID` | Application (client) ID |
| `ENTRA_CLIENT_SECRET` | The client secret value |
| `TRUST_ADMIN_EMAILS` | Your email, plus anyone else who must always be a trust admin, separated by commas |
| `MAIL_SENDER` | The mailbox to send from, e.g. `trips@lwlat.org.uk` |
| `SITE_URL` | *(Optional)* The site address used in email links, e.g. `https://trips.lwlat.org.uk`. Defaults to whatever address the site is opened on. |

Then *Deploys → Trigger deploy*.

### 4. First sign-in

1. Open the site and select **Sign in with Microsoft**. You're a trust admin because your email is in `TRUST_ADMIN_EMAILS`.
2. Go to **Trust admin** and fill in:
   - **Trust-wide email domains**, e.g. `lwlat.org.uk`. Staff on these domains can go on any school's trip.
   - **Each school's email domains** and its **trip organisers** (one email per line).
   - Any other **trust admins**.
3. Save. Organisers can now sign in and create trips.

### 5. Linking from Pulse

Link the Pulse tile to `https://<your-site>/?sso=1`. Staff already signed in to Microsoft through Pulse go straight in without a sign-in prompt.

---

## Creating a trip (organisers)

1. Sign in, then choose the school and select **+ New trip**.
2. Enter the trip name, venue and start and end dates. Tick the lunchtime check-in if you want one, and add any other check-ins.
3. Upload the pupil CSV. The template is on the Trips page (**CSV template**) or in `public/trip-template.csv`. Check the preview and warnings.
4. Add the **trip lead** and **other staff** (names and work emails).
5. Select **Create trip and email staff**. Each person gets an email with the link, their email address and their personal password.
   - If email isn't set up yet, or an email fails, the passwords are shown to you **once** to pass on in person or by Teams.
   - **New password & email** on the Manage page issues a fresh password at any time. The old one stops working straight away.

### The CSV

Required: **First Name**, **Last Name**. Optional: Admission No, Year Group, Form, Staff Group, Medical Needs, Allergies, Medication, Emergency Contact Name / Relationship / Phone, Emergency Contact 2 Name / Phone, **Home Arrangement** (`Collected` or `Own way home`), **Collected By**, Notes.

Common column names from MIS exports are also recognised (e.g. *Forename*, *Surname*, *Reg Group*, *UPN*). In Excel, save as **CSV UTF-8**.

## On the day (trip staff)

- Open the link in the trip email, then enter your work email and password. You only ever see that trip.
- Tap **Mark present / Mark here / Hand over / Dismiss** to mark a child. Tap a name for medical details, emergency contacts (tap to call) and other actions.
- **+ Add pupil** for a child who joins on the day; you'll be asked why. To remove a child, tap their name, then **Remove from trip** (also needs a reason). Both are recorded against you.
- A red banner shows how many children haven't been seen at the current check. Screens update every few seconds across everyone's phones.

## Data protection: before going live

This stores pupil names, medical information and emergency contacts.

- Complete or update a **DPIA** with your DPO, covering Netlify (processor; Data Processing Addendum available) and the Microsoft Graph mail sending.
- Data is stored in Netlify Blobs in the **EU (Frankfurt)** region. That's fixed the first time the site stores anything, so don't change `BLOBS_REGION` later.
- Agree a **retention rule**, e.g. organisers download the CSV/PDF and **delete the trip** within *N* days of it ending. Deletions are recorded in the activity log.
- Trip passwords are stored only as secure hashes. They're shown once (or emailed) and can't be recovered, only reset.
- Login attempts are rate-limited (8 failures → 10-minute lockout). Cookies are HttpOnly, Secure and SameSite, and the site tells search engines not to index it.
- Keep the GitHub repository **private**, and put a calendar reminder in for the **client secret's expiry date**.

## Run it locally (for testing)

Requires Node.js 18 or later.

```
npm install
npm run dev
```

Open http://localhost:8888. Locally, **Sign in with Microsoft** shows a test page where you can sign in as any email. `admin@lwlat.org.uk` is a trust admin. That page only works on `localhost` and never on Netlify. Email isn't sent locally, so passwords are shown on screen instead. Data is saved in `.local-data/`.

## Files

- `public/`: the website (HTML, CSS, JS, logo, CSV template)
- `lib/core.mjs`: all server logic (sign-in, trip logins, trips, registers, email, logs, exports)
- `netlify/functions/api.mjs`: connects that logic to Netlify Functions and Blobs
- `dev-server.mjs`: local test server only
