#!/usr/bin/env bun
/**
 * Inserts a synthetic forwarded meeting email into the user's INBOX (no SMTP)
 * for end-to-end testing of the gmail-triage → calendar existence-check
 * pipeline. Uses users.messages.import to set an arbitrary `From:` header so
 * the message looks like a real forward from a friend.
 *
 * Run once, trigger workflow, verify ## Meetings — missing-on-calendar lands
 * in the triage MD, then DELETE the inserted thread.
 */
import { gmail_v1, auth } from "@googleapis/gmail";
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
const gmail = new gmail_v1.Gmail({ auth: oauth2 });

const PERSONAL = "sonthanhdo2004@gmail.com";
const FORWARDER = "ngtranthanh@gmail.com"; // synthetic friend
const ORGANIZER = "marie@etude-rive-droite.example";

// Schedule: 2 weeks out, 15:00 Europe/Zurich
const meetingDate = new Date();
meetingDate.setDate(meetingDate.getDate() + 14);
const isoDate = meetingDate.toISOString().slice(0, 10);

const subject = "Fwd: Confirmation rendez-vous notaire";
const body = `mai roi nho len van phong notaire luc 3pm nhe

---------- Forwarded message ---------
From: <${ORGANIZER}>
Date: Mon, 4 May 2026 at 14:00
Subject: Confirmation rendez-vous

Bonjour Monsieur Do,

Je vous confirme votre rendez-vous le ${isoDate} à 15h00 à notre étude
au 12 rue du Rhône, 1204 Genève.

Merci d'apporter les documents originaux.

Cordialement,
Marie
Étude Rive-Droite
`;

const raw = [
  `From: Tran Thanh Nguyen <${FORWARDER}>`,
  `To: ${PERSONAL}`,
  `Subject: ${subject}`,
  `Date: ${new Date().toUTCString()}`,
  `Message-ID: <synthetic-${Date.now()}@example.com>`,
  `MIME-Version: 1.0`,
  `Content-Type: text/plain; charset=UTF-8`,
  ``,
  body,
].join("\r\n");

const encoded = Buffer.from(raw, "utf-8")
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

const r = await gmail.users.messages.import({
  userId: "me",
  internalDateSource: "dateHeader",
  neverMarkSpam: true,
  processForCalendar: false,
  requestBody: {
    raw: encoded,
    labelIds: ["INBOX", "UNREAD"],
  },
});

console.log(JSON.stringify({
  message_id: r.data.id,
  thread_id: r.data.threadId,
  meeting_date: isoDate,
  meeting_time: "15:00 Europe/Zurich",
  forwarder: FORWARDER,
  organizer: ORGANIZER,
}, null, 2));
