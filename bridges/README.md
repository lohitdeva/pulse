# College timetable bridge

`college.gs` runs in the college Google account, reads the `Schedule` tab, and POSTs its displayed grid and merged-cell A1 ranges to Pulse. It sends only `{ "values": string[][], "merges": string[] }` and authenticates with an `Authorization: Bearer …` header. The script does not write to the source sheet.

## Setup

The `ingest-timetable` endpoint is ticket T2.3 and is not part of this bridge ticket. Wait until T2.3 has deployed the endpoint and provided its matching bearer secret before running a sync or installing triggers. Without that endpoint, the script cannot deliver timetable data.

1. Sign in to the college Google account that can view the timetable. Open [script.google.com](https://script.google.com), create a **New project**, and name it `Pulse College Timetable`.
2. Replace the starter code in `Code.gs` with the contents of [`college.gs`](./college.gs), then save.
3. In a separate tab, open the college timetable spreadsheet. Copy the ID between `/d/` and the next `/` in its address bar; do not share the URL.
4. In Apps Script, open **Project Settings** (gear) → **Script Properties** → **Add script property**. Add these properties; keep their values private:

   | Property | Value |
   | --- | --- |
   | `COLLEGE_SPREADSHEET_ID` | The spreadsheet ID from step 3. |
   | `COLLEGE_INGEST_TIMETABLE_URL` | The HTTPS endpoint supplied for T2.3, in the form `https://<project-ref>.supabase.co/functions/v1/ingest-timetable`. Do not add a query string or token to the URL. |
   | `COLLEGE_INGEST_TIMETABLE_BEARER_SECRET` | The exact bearer secret configured for the T2.3 endpoint. |

5. After T2.3 is deployed and the three properties are set, select `syncCollegeTimetable` in the function picker and click **Run**. Review the Google permission prompt and allow spreadsheet read access and external requests. The returned status and counts confirm a successful run; failures show only a generic message or HTTP status, not the secret or response body.
6. Select `installCollegeTimetableTriggers` and click **Run** once. Authorize trigger creation if prompted. It replaces any existing triggers for this handler and creates daily runs near 5:30 AM and 12:30 PM in `Asia/Kolkata`. Running it again is safe and does not add duplicates.

## Manual sync and maintenance

To sync on demand, select `syncCollegeTimetable` and click **Run**. In **Triggers** (clock icon), confirm the two `syncCollegeTimetable` triggers are listed. If you rotate the backend bearer secret, update `COLLEGE_INGEST_TIMETABLE_BEARER_SECRET` in Script Properties and run a manual sync to check the new value. Never paste the secret into source code, URLs, execution logs, screenshots, or support messages.

Apps Script schedules time-driven triggers near the requested minute; the run may be offset by several minutes. It runs as the college account that installed the triggers, so that account must retain view access to the source sheet.
