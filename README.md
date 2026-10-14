# W&L Athletics Van and MiFi Reservations

A self-service reservation site for the Athletics fleet (Van 97, 140, 203, 206, 207, Mini Van 208, Mini Van 209) and MiFi hotspots 1, 2, 3, 4, 5, 6, and 8.

**What coaches see**
- **Vans** and **MiFi hotspots** tabs, each as a Table, Cards, or Calendar for any date range
- Green **Reserve** buttons on everything that is open. Vans also have **Reserve ... + MiFi**, which adds the first open MiFi
- A one-step-at-a-time form: Dates, What you need, Your details, Review. Reserved vans and MiFis stay visible but greyed out, with who has them and when
- **Modify or Cancel Reservation**: switch dates, van, or MiFi (showing what is and is not open), or cancel. A van and MiFi booked together always modify or cancel together
- **Make this page easier to read**: text size, high contrast, dark mode, and reduce motion, remembered on that device
- Reservations are full days, first come, first served, with no approval step
- Returns from the van QR code form link to the reservation and show as Returned with mileage and fuel

## Brand colors (W&L brand guide)

| Name | PMS | HEX | Used for |
|---|---|---|---|
| W&L Blue | 287 | #003087 | Header, tabs, selected buttons |
| Slate | 7545 | #425563 | Secondary text, form borders |
| Cannan Green | 348 | #00843D | Reserve buttons, "Available" |
| Autumn Leaf | 7409 | #F0B323 | Modify or Cancel Reservation button |
| Brick | 208 | #861F41 | "Reserved", Cancel buttons |
| Blue Ridge | 7690 | #0076A8 | "Returned", keyboard focus outline |

Headings use Palatino; body text uses Arial, the brand guide's approved web substitute. Every status pairs its color with a symbol and a word (check for Available, X for Reserved, diamond for Returned, triangle for Not returned), so color is never the only signal. To change a color, edit the variables at the top of `styles.css`.

## How it fits together

```
Coach books on the GitHub page
        |
        v
Google Apps Script (Code.gs, inside the sheet)  -->  "Van Reservations" tab: one row per reservation
        ^                                                     ^
        |                                                     | fills in Returned At, mileage, tank, issues
GitHub page reads reservations + returns                      |
                                              Return Google Form (QR code in each van)
                                              "Form Responses" tab gets a Reservation ID column
```

## Files

| File | Where it goes |
|---|---|
| `index.html`, `styles.css`, `app.js`, `config.js` | GitHub (replace the version 1 files) |
| `Code.gs` | **Not GitHub.** Paste it into the Google Sheet's Apps Script editor (Step 2) |
| `README.md` | GitHub (these instructions) |

---

## Step 1. Update GitHub

In your `van-reservations` repository, choose **Add file > Upload files**, drag in `index.html`, `styles.css`, `app.js`, `config.js`, and `README.md`, and commit. They replace the old files. You can also upload `Code.gs` to keep a backup copy; it does nothing there.

## Step 2. Add the script to the Google Sheet

1. Open the **Van Checkout 2026-27** sheet.
2. Choose **Extensions > Apps Script**.
3. Delete anything in `Code.gs`, paste in the full contents of this `Code.gs`, and click **Save**.
4. Click the gear icon (**Project Settings**) and set the **Time zone** to `(GMT-04:00) Eastern Time - New York`.
5. Back in the editor, choose **setup** in the function dropdown at the top and click **Run**.
   - Google asks you to authorize. Choose your account. If you see "Google hasn't verified this app," click **Advanced > Go to (project name)**. This is normal for a script you wrote yourself.
   - The log at the bottom shows which return form tab and questions it found, for example `van: "Which van are you returning?"`. If anything says `(not found)`, let me know the exact question wording.
6. Look at the sheet. You will see:
   - A new **Van Reservations** tab
   - A new **Reservation ID** column at the end of the form responses tab
   - A **Van Reservations** menu at the top (reload the sheet if you don't see it)
7. Publish the script: click **Deploy > New deployment**, click the gear next to "Select type," and choose **Web app**.
   - Description: `Van reservations`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

**Updating from an earlier version of Code.gs:** paste in the new version, save, run **setup** again (this adds the new columns without touching existing rows), then deploy a new version.

**After you edit Code.gs later**, use **Deploy > Manage deployments**, click the pencil, set Version to **New version**, and click **Deploy**. The URL stays the same.

Your existing QR codes and the return form need no changes.

## Step 3. Set up W&L sign-in

This is the same as before: a free "app registration" in Microsoft Entra. If W&L doesn't let staff create one, send IT this request:

> **Request for IT:** Please create a single-page application registration in Entra ID named "Athletics Van Reservations," single tenant, with SPA redirect URI `https://YOUR-GITHUB-NAME.github.io/van-reservations/` and delegated Microsoft Graph User.Read. It is used only to sign W&L staff into the Athletics van reservation page. Please send me the Application (client) ID and Directory (tenant) ID.

When a coach books, the sheet script checks the sign-in directly with Microsoft, so only real @wlu.edu accounts can reserve.

**Testing before IT responds:** `Code.gs` currently has `REQUIRE_MICROSOFT_SIGNIN: false`, so the page asks for a W&L email instead of a sign-in. Once sign-in works, change it to `true`, save, and deploy a new version. With it off, anyone who has the link could type any @wlu.edu email.

## Step 4. Fill in config.js on GitHub

Open `config.js` in GitHub, click the pencil to edit, and fill in:

```js
apiUrl: "PASTE THE WEB APP URL FROM STEP 2",
auth: {
  clientId: "PASTE APPLICATION (CLIENT) ID",
  tenantId: "PASTE DIRECTORY (TENANT) ID",
  redirectUri: ""
},
```

Commit the change. The yellow demo banner disappears and the site is live.

## Step 5. Test

1. Reserve a van for today on the site. A new row appears on the **Van Reservations** tab with an ID like `R0001` and Status **Reserved**.
2. Try to reserve the same van for the same day. It is not offered.
3. Scan that van's QR code and submit the return form.
4. Within about a minute:
   - The reservation row changes to **Returned** and fills in Returned At, Return Driver, Return Mileage, Full Tank, and Issues.
   - The form response row shows the matching **Reservation ID**.
   - The site shows the trip as **Returned** with the mileage and fuel.

---

## How returns are matched

When a return form comes in, the script reads the van number from the answer (it understands "Van 208", "Mini Van 208", "207 Extended Storage," and so on). It then picks that van's open reservation that started most recently on or before the return date. Returns up to 14 days after the end date still match.

- **Returned early:** the remaining days free up automatically, so someone else can book them.
- **No reservation found** (for example, someone took a van without booking): the response's Reservation ID says `No matching reservation`. To fix it later, correct the reservation or the response, clear that cell, and choose **Van Reservations > Match returns to reservations**.
- **Trip ended but no return form:** the site shows an orange **Not returned** label and a note on that van's card, so you can follow up.
- **Return forms submitted before this system existed** are marked `No matching reservation` during setup. That is expected.

## MiFi hotspots

- **With a van:** in the booking form, pick a van, then choose a MiFi from the **MiFi hotspot (optional)** dropdown. Only MiFis free for those dates are listed.
- **On its own:** choose **No van, MiFi only**, then pick the MiFi. Or click **Reserve MiFi #** on a MiFi card in the list view.
- **In the sheet:** the MiFi number goes in the **MiFi** column of the same reservation row, so one row covers the van and the MiFi.
- **Returns:** a MiFi booked with a van is treated as returned when that van's return form comes in. A MiFi-only booking frees up after its last day and shows as **Completed**.
- **Adding or retiring a MiFi:** edit `mifis` in `config.js` and `MIFIS` at the top of `Code.gs`, then deploy a new version.

## Modifying or cancelling a reservation

Coaches click **Modify or Cancel Reservation** at the top of the site. Once W&L sign-in is set up, the site already knows who they are. Until then, they type the email they booked with. Each upcoming reservation has two buttons:

- **Modify:** pick new dates, a different van or MiFi, or update the details. Every van and MiFi is listed; ones that are taken are greyed out with who has them and when.
- **Cancel:** asks to confirm, then frees the van and any MiFi booked with it.

Rules:
- People can only change or cancel reservations they made (matched by email).
- A trip that has already started can't be cancelled or moved to a different van or start date. The end date and details can still be changed. To end a trip early, return the van and submit the return form.
- Returned, cancelled, and past reservations can't be changed.
- Every change and cancellation is recorded on the reservation's row in the **Last Changed** and **Change Log** columns, so you keep a full history.

**Admins:** to let yourself change or cancel anyone's reservation from the site, add your email to `ADMINS` near the top of `Code.gs`, for example `ADMINS: ['you@wlu.edu'],`. Then save and deploy a new version.

**Testing note:** until W&L sign-in is turned on, someone who typed another person's email could see and change that person's reservations. That's fine for testing, but turn sign-in on before sharing the site with coaches.

## Day-to-day in the sheet

| Task | How |
|---|---|
| Cancel a reservation | Coaches use **My reservations** on the site. You can also change Status to **Cancelled** on the **Van Reservations** tab. The van frees up on the site within a minute. |
| Change dates or team | Edit the row directly. Type dates as `2026-10-14`. |
| Print or save records | Use the **Van Reservations** tab. Filter it, then **File > Print** or **File > Download**. It has both the booking and the return on one row. |
| Don't edit | The **Reservation ID** column, or the column headers on either tab. The script uses them to find things. |

## Keeping it running after staffing changes

The script runs under the Google account that owns the sheet. If that's a personal account, the system goes with that account. Share the sheet with edit access to at least one other staff member, and keep a copy of `Code.gs` in GitHub, so someone else can redeploy it if needed.

## Troubleshooting

- **"Could not load reservations"**: check that `apiUrl` in `config.js` is the Web app URL ending in `/exec` and that "Who has access" is **Anyone**.
- **"Please sign in with your W&L account and try again"** after signing in: sign out and back in. If it continues, check that the app registration has Microsoft Graph **User.Read**.
- **A return didn't link**: check that the van answer on the form contains the van number, then use **Van Reservations > Match returns to reservations**.
- **Adding or retiring a van**: edit `vans` in `config.js` and `VANS` at the top of `Code.gs`, then deploy a new version.
