#!/usr/bin/env bun
/**
 * Generic Google Calendar event creator using the plugin's OAuth credentials.
 *
 * Reads ~/work/brain-os-plugin/skills/gmail/.credentials.json (must have
 * calendar.events scope — set up via setup-oauth.ts).
 *
 * Used by the /gmail create flow to backfill calendar events for personal
 * meetings the workflow flagged as missing-on-calendar.
 *
 * Usage:
 *   bun calendar-create.ts \
 *     --title "Carrosserie Perroud — devis check" \
 *     --start "2026-05-05T08:00:00" \
 *     --end "2026-05-05T09:00:00" \
 *     --tz "Europe/Zurich" \
 *     [--location "Perroud Carrosserie SA, Vich"] \
 *     [--description "Notes..."] \
 *     [--reminder-min 30] \
 *     [--dry-run]
 *
 * Prints the event htmlLink on success.
 */
import { auth, calendar_v3 } from "@googleapis/calendar";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH =
  process.env.GMAIL_CREDENTIALS_PATH ||
  resolve(__dirname, "../.credentials.json");

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const title = getArg("title");
const start = getArg("start");
const end = getArg("end");
const tz = getArg("tz") || "Europe/Zurich";
const location = getArg("location") || "";
const description = getArg("description") || "";
const reminderMin = parseInt(getArg("reminder-min") || "30", 10);
const dryRun = hasFlag("dry-run");

if (!title || !start || !end) {
  console.error("Required: --title, --start, --end (ISO-8601 local time)");
  process.exit(1);
}

if (dryRun) {
  console.log("DRY RUN — would create:");
  console.log(JSON.stringify({ title, start, end, tz, location, description, reminderMin }, null, 2));
  process.exit(0);
}

const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
const oauth2 = new auth.OAuth2(creds.client_id, creds.client_secret);
oauth2.setCredentials({
  refresh_token: creds.refresh_token,
  access_token: creds.access_token,
});

const cal = new calendar_v3.Calendar({ auth: oauth2 });

const event = await cal.events.insert({
  calendarId: "primary",
  requestBody: {
    summary: title,
    location,
    description,
    start: { dateTime: start, timeZone: tz },
    end: { dateTime: end, timeZone: tz },
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: reminderMin }],
    },
  },
});

console.log(event.data.htmlLink);
