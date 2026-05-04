#!/usr/bin/env bun
import { auth, calendar_v3 } from "@googleapis/calendar";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = resolve(__dirname, "../.credentials.json");

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
    summary: "Carrosserie Perroud — devis check",
    location: "Perroud Carrosserie SA, Chemin de la Bichette 7, 1267 Vich, Switzerland",
    description:
      "Bring car to Perroud carrosserie for damage inspection + quote.\n\n" +
      "Forwarded by Duong Nguyen (haduongnt@gmail.com). Tanya (tanya@perroud.ch) confirmed appointment.\n\n" +
      "Phone: +41 22 364 82 61\n" +
      "Email: carrosserie@perroud.ch\n\n" +
      "Gmail thread: https://mail.google.com/mail/u/0/#inbox/19dd8e0b6f9e79bc",
    start: { dateTime: "2026-05-05T08:00:00", timeZone: "Europe/Zurich" },
    end: { dateTime: "2026-05-05T09:00:00", timeZone: "Europe/Zurich" },
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 30 }],
    },
  },
});

console.log("Event created:", event.data.htmlLink);
