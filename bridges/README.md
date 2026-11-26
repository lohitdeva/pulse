# College timetable bridge

`college.gs` runs in the college Google account, reads the `Schedule` tab, and POSTs its displayed grid and merged-cell A1 ranges to Pulse. It sends only `{ "values": string[][], "merges": string[] }` and authenticates with an `Authorization: Bearer …` header. The script does not write to the source sheet.

## Setup

The `ingest-timetable` function accepts a custom bearer secret and always reconciles against the explicitly configured Supabase owner. It does not accept an owner ID from the request. The function uses the Supabase service role key only for the service-only reconciliation RPC.

## Deploy and configure the endpoint

1. Set `COLLEGE_INGEST_TIMETABLE_BEARER_SECRET` to a private random value of at least 32 characters and `COLLEGE_TIMETABLE_OWNER_ID` to the timetable owner's Supabase Auth user UUID. Store both as Supabase function secrets; do not put either in the app bundle or a URL.
2. Deploy from the repository with `supabase functions deploy ingest-timetable`. The function's `verify_jwt = false` setting is required because the bridge uses its own bearer secret.
3. Use the deployed function URL and the same bearer secret in the Apps Script properties below.

4. Sign in to the college Google account that can view the timetable. Open [script.google.com](https://script.google.com), create a **New project**, and name it `Pulse College Timetable`.
5. Replace the starter code in `Code.gs` with the contents of [`college.gs`](./college.gs), then save.
6. In a separate tab, open the college timetable spreadsheet. Copy the ID between `/d/` and the next `/` in its address bar; do not share the URL.
7. In Apps Script, open **Project Settings** (gear) → **Script Properties** → **Add script property**. Add these properties; keep their values private:

   | Property                                 | Value                                                                                                                                                               |
   | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `COLLEGE_SPREADSHEET_ID`                 | The spreadsheet ID from step 3.                                                                                                                                     |
   | `COLLEGE_INGEST_TIMETABLE_URL`           | The HTTPS endpoint supplied for T2.3, in the form `https://<project-ref>.supabase.co/functions/v1/ingest-timetable`. Do not add a query string or token to the URL. |
   | `COLLEGE_INGEST_TIMETABLE_BEARER_SECRET` | The exact bearer secret configured for the T2.3 endpoint.                                                                                                           |

8. Select `syncCollegeTimetable` and click **Run** for a manual sync. Review the Google permission prompt and allow spreadsheet read access and external requests. The returned status and counts confirm a successful run; failures show only a generic message or HTTP status, not the secret or response body.
9. After the manual sync succeeds, select `installCollegeTimetableTriggers` and click **Run** once. Authorize trigger creation if prompted. It replaces any existing triggers for this handler and creates daily runs near 5:30 AM and 12:30 PM in `Asia/Kolkata`. Running it again is safe and does not add duplicates.

## Manual sync and maintenance

To sync on demand, select `syncCollegeTimetable` and click **Run**. In **Triggers** (clock icon), confirm the two `syncCollegeTimetable` triggers are listed. If you rotate the backend bearer secret, update `COLLEGE_INGEST_TIMETABLE_BEARER_SECRET` in Script Properties and run a manual sync to check the new value. Never paste the secret into source code, URLs, execution logs, screenshots, or support messages.

Apps Script schedules time-driven triggers near the requested minute; the run may be offset by several minutes. It runs as the college account that installed the triggers, so that account must retain view access to the source sheet.
